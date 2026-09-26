// @vitest-environment node

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const helperPath = resolve('scripts/lib/biometrics-archiver-helpers')
const archiverScript = resolve('modules/biometrics-archiver/sleepypod-biometrics-archiver')
const linkerScript = resolve('modules/biometrics-archiver/sleepypod-biometrics-linker')

let root: string
let tmpfsDir: string
let pendingDir: string
let archiveDir: string
let systemdDir: string
let localBinDir: string
let stubBinDir: string
let archiverBin: string
let recoveryTool: string
let mountUnit: string
let callsFile: string
let unmountedFile: string

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, lines.join(String.fromCharCode(10)), { mode: 0o755 })
}

function writeRaw(name = '00001.RAW', body = 'sensor frame'): string {
  const path = join(tmpfsDir, name)
  writeFileSync(path, body)
  return path
}

function calls(): string {
  return existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''
}

/** Env shared by direct script runs: stub PATH plus the tmpfs/archive paths. */
function scriptEnv(extraEnv: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [stubBinDir, process.env.PATH ?? ''].join(':'),
    UNMOUNTED_FILE: unmountedFile,
    TMPFS_DIR: tmpfsDir,
    ARCHIVE_DIR: archiveDir,
    ...extraEnv,
  }
}

function runLinker(extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  return spawnSync('/bin/bash', [linkerScript], { encoding: 'utf8', env: scriptEnv(extraEnv) })
}

function runArchiver(extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  // KEEP_RECENT_MIN defaults high so the live-frame pass stays out of the way
  // of tests about pinned links; the firmware-left-behind path passes its own.
  return spawnSync('/bin/bash', [archiverScript], {
    encoding: 'utf8',
    env: scriptEnv({ KEEP_RECENT_MIN: '15', ...extraEnv }),
  })
}

function pendingEntries(): string[] {
  return existsSync(pendingDir) ? readdirSync(pendingDir).sort() : []
}

function runHelper(extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  return spawnSync('/bin/bash', ['-c', '. "$HELPER_PATH"; remove_biometrics_archiver_for_nats'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [stubBinDir, process.env.PATH ?? ''].join(':'),
      HELPER_PATH: helperPath,
      BIOMETRICS_SYSTEMD_DIR: systemdDir,
      BIOMETRICS_LOCAL_BIN_DIR: localBinDir,
      BIOMETRICS_TMPFS_DIR: tmpfsDir,
      BIOMETRICS_ARCHIVER_BIN: archiverBin,
      BIOMETRICS_FRANK_SH: join(root, 'frank.sh'),
      CALLS_FILE: callsFile,
      UNMOUNTED_FILE: unmountedFile,
      FAIL_RESTART: '0',
      STOP_LEAVES_MOUNTED: '0',
      ...extraEnv,
    },
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-archiver-'))
  tmpfsDir = join(root, 'biometrics')
  pendingDir = join(tmpfsDir, '.pending')
  archiveDir = join(root, 'biometrics-archive')
  systemdDir = join(root, 'systemd')
  localBinDir = join(root, 'local-bin')
  stubBinDir = join(root, 'stub-bin')
  callsFile = join(root, 'systemctl.calls')
  unmountedFile = join(root, 'unmounted')
  for (const dir of [tmpfsDir, archiveDir, systemdDir, localBinDir, stubBinDir]) {
    mkdirSync(dir, { recursive: true })
  }

  writeExecutable(join(stubBinDir, 'mountpoint'), [
    '#!/usr/bin/env bash',
    '[ -f "$UNMOUNTED_FILE" ] && exit 1',
    'exit 0',
  ])
  writeExecutable(join(stubBinDir, 'systemctl'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$CALLS_FILE"',
    'if [ "$1" = "restart" ] && [ "$2" = "frank.service" ] && [ "$FAIL_RESTART" = "1" ]; then',
    '  exit 1',
    'fi',
    'if [ "$1" = "stop" ] && [ "$2" = "persistent-biometrics.mount" ]; then',
    '  if [ "$STOP_LEAVES_MOUNTED" != "1" ]; then',
    '    : > "$UNMOUNTED_FILE"',
    '  fi',
    'fi',
    'exit 0',
  ])

  archiverBin = join(localBinDir, 'sleepypod-biometrics-archiver')
  recoveryTool = join(localBinDir, 'sleepypod-biometrics-pruner')
  mountUnit = join(systemdDir, 'persistent-biometrics.mount')
  writeExecutable(archiverBin, ['#!/usr/bin/env bash', 'exit 0'])
  writeExecutable(recoveryTool, ['#!/usr/bin/env bash', 'exit 0'])
  writeFileSync(mountUnit, '[Mount]')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('sleepypod-biometrics-linker', () => {
  it('pins a live frame so it survives the firmware unlinking it at rotation', () => {
    const live = writeRaw('0016B64E.RAW')

    const result = runLinker()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('linked=1')
    const pinned = join(pendingDir, '0016B64E.RAW')
    // Same inode: no extra tmpfs while the firmware is still appending.
    expect(statSync(pinned).ino).toBe(statSync(live).ino)

    rmSync(live) // what the firmware does within a second of rotating
    expect(readFileSync(pinned, 'utf8')).toBe('sensor frame')
  })

  it('keeps the frames the firmware appends after the link exists', () => {
    // The pin is a second name for one inode, not a snapshot: everything the
    // firmware writes between the link and the rotation has to be in there.
    const live = writeRaw('0016B64E.RAW', 'first half ')

    runLinker()
    appendFileSync(live, 'second half')
    rmSync(live)

    expect(readFileSync(join(pendingDir, '0016B64E.RAW'), 'utf8')).toBe('first half second half')
  })

  it('skips SEQNO.RAW and the tmpfs-prep symlinks', () => {
    writeRaw('SEQNO.RAW')
    const emmcFile = join(root, 'state.RAW')
    writeFileSync(emmcFile, 'firmware state')
    symlinkSync(emmcFile, join(tmpfsDir, 'staged.RAW'))

    const result = runLinker()

    expect(result.status).toBe(0)
    expect(pendingEntries()).toEqual([])
  })

  it('stays quiet and pins nothing on a repeat run', () => {
    writeRaw()
    runLinker()

    const result = runLinker()

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
    expect(pendingEntries()).toEqual(['00001.RAW'])
  })

  it('skips without touching anything when the tmpfs is not mounted', () => {
    writeFileSync(unmountedFile, '')
    writeRaw()

    const result = runLinker()

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('not a tmpfs mount')
    expect(existsSync(pendingDir)).toBe(false)
  })

  it('drops the oldest pinned frame when pending outgrows its tmpfs share', () => {
    // A stuck archiver must not let pinned frames crowd out live writes.
    const body = 'x'.repeat(256 * 1024)
    const older = writeRaw('00001.RAW', body)
    const newer = writeRaw('00002.RAW', body)
    utimesSync(older, new Date(1000), new Date(1000))
    utimesSync(newer, new Date(2000), new Date(2000))
    // Stub df so the cap lands between one and two pinned frames.
    writeExecutable(join(stubBinDir, 'df'), [
      '#!/usr/bin/env bash',
      'echo "Filesystem 1024-blocks Used Available Capacity Mounted-on"',
      'echo "tmpfs 800 0 800 0% /persistent/biometrics"',
    ])

    const result = runLinker({ PENDING_MAX_PCT: '50' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dropped=1')
    expect(pendingEntries()).toEqual(['00002.RAW'])
    // Live frames belong to the firmware — the linker never removes those.
    expect(existsSync(older)).toBe(true)
    expect(existsSync(newer)).toBe(true)
  })

  it('keeps every pinned frame when df reports no usable capacity', () => {
    writeRaw()
    writeExecutable(join(stubBinDir, 'df'), ['#!/usr/bin/env bash', 'exit 1'])

    const result = runLinker()

    expect(result.status).toBe(0)
    expect(pendingEntries()).toEqual(['00001.RAW'])
  })
})

describe('sleepypod-biometrics-archiver', () => {
  it('archives a pinned frame once the firmware has released the live file', () => {
    const live = writeRaw('0016B64E.RAW', 'waveform bytes')
    runLinker()
    rmSync(live)

    const result = runArchiver()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('archived=1')
    expect(result.stdout).toContain('pending=0')
    const gz = join(archiveDir, '0016B64E.RAW.gz')
    expect(gunzipSync(readFileSync(gz)).toString()).toBe('waveform bytes')
    expect(pendingEntries()).toEqual([])
  })

  it('leaves a pinned frame alone while the firmware still holds the live file', () => {
    writeRaw()
    runLinker()

    const result = runArchiver()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('archived=0')
    expect(result.stdout).toContain('pending=1')
    expect(existsSync(join(archiveDir, '00001.RAW.gz'))).toBe(false)
    expect(pendingEntries()).toEqual(['00001.RAW'])
  })

  it('drops a pinned frame that is already in the archive', () => {
    const live = writeRaw()
    runLinker()
    rmSync(live)
    mkdirSync(archiveDir, { recursive: true })
    const gz = join(archiveDir, '00001.RAW.gz')
    writeFileSync(gz, gzipSync(Buffer.from('archived earlier')))

    const result = runArchiver()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('removed=1')
    expect(pendingEntries()).toEqual([])
    expect(gunzipSync(readFileSync(gz)).toString()).toBe('archived earlier')
  })

  it('archives a live frame the firmware left behind and clears its pin', () => {
    writeRaw()
    runLinker()

    const result = runArchiver({ KEEP_RECENT_MIN: '-1' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('archived=1')
    expect(result.stdout).toContain('removed=1')
    expect(result.stdout).toContain('pending=0')
    expect(existsSync(join(tmpfsDir, '00001.RAW'))).toBe(false)
    expect(pendingEntries()).toEqual([])
  })

  it('returns nonzero and preserves the source when gzip fails', () => {
    const raw = writeRaw()
    writeExecutable(join(stubBinDir, 'gzip'), ['#!/usr/bin/env bash', 'exit 1'])

    const result = spawnSync('/bin/bash', [archiverScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [stubBinDir, process.env.PATH ?? ''].join(':'),
        TMPFS_DIR: tmpfsDir,
        ARCHIVE_DIR: archiveDir,
        KEEP_RECENT_MIN: '-1',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('failed=1')
    expect(existsSync(raw)).toBe(true)
  })
})

describe('remove_biometrics_archiver_for_nats', () => {
  it('does not unmount or remove recovery tools when the archiver fails', () => {
    const raw = writeRaw()
    writeExecutable(archiverBin, ['#!/usr/bin/env bash', 'exit 1'])

    const result = runHelper()

    expect(result.status).toBe(1)
    expect(calls()).not.toContain('stop persistent-biometrics.mount')
    expect(existsSync(raw)).toBe(true)
    expect(existsSync(mountUnit)).toBe(true)
    expect(existsSync(recoveryTool)).toBe(true)
  })

  it('rejects a successful archiver exit when a RAW frame remains', () => {
    const raw = writeRaw()
    writeExecutable(archiverBin, ['#!/usr/bin/env bash', 'exit 0'])

    const result = runHelper()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unarchived RAW frame remains')
    expect(calls()).not.toContain('stop persistent-biometrics.mount')
    expect(existsSync(raw)).toBe(true)
  })

  it('rejects a successful archiver exit when a pinned frame remains', () => {
    // A pinned link can be the only surviving copy of an unlinked frame, so it
    // blocks the unmount exactly like a live frame would.
    mkdirSync(pendingDir, { recursive: true })
    const pinned = join(pendingDir, '00001.RAW')
    writeFileSync(pinned, 'sensor frame')

    const result = runHelper()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unarchived RAW frame remains')
    expect(calls()).not.toContain('stop persistent-biometrics.mount')
    expect(existsSync(pinned)).toBe(true)
  })

  it('rejects missing archival tooling when a RAW frame remains', () => {
    const raw = writeRaw()
    rmSync(archiverBin)

    const result = runHelper()

    expect(result.status).toBe(1)
    expect(calls()).not.toContain('stop persistent-biometrics.mount')
    expect(existsSync(raw)).toBe(true)
  })

  it('allows SEQNO.RAW alone and completes cleanup', () => {
    const seqno = writeRaw('SEQNO.RAW')
    rmSync(archiverBin)

    const result = runHelper()

    expect(result.status).toBe(0)
    expect(calls()).toContain('stop persistent-biometrics.mount')
    expect(existsSync(seqno)).toBe(true)
    for (const unit of ['sleepypod', 'sleepypod-cover-buttons', 'sleepypod-sleep-detector', 'sleepypod-piezo-processor', 'sleepypod-calibrator', 'sleepypod-environment-monitor']) {
      expect(readFileSync(join(systemdDir, `${unit}.service.d/zz-nats-raw-fallback.conf`), 'utf8'))
        .toContain('Environment="RAW_DATA_DIR=/persistent"')
    }
    expect(calls().indexOf('daemon-reload')).toBeLessThan(calls().indexOf('stop persistent-biometrics.mount'))
    expect(existsSync(mountUnit)).toBe(false)
    expect(existsSync(recoveryTool)).toBe(false)
  })

  it('archives all frames before unmounting and removing recovery tools', () => {
    const raw = writeRaw()

    const result = runHelper({
      BIOMETRICS_ARCHIVER_BIN: archiverScript,
      TMPFS_DIR: tmpfsDir,
      ARCHIVE_DIR: archiveDir,
    })

    expect(result.status).toBe(0)
    expect(calls()).toContain('stop persistent-biometrics.mount')
    expect(existsSync(raw)).toBe(false)
    expect(existsSync(join(archiveDir, '00001.RAW.gz'))).toBe(true)
    expect(existsSync(mountUnit)).toBe(false)
    expect(existsSync(recoveryTool)).toBe(false)
  })

  it('preserves the mount and recovery tools when frank cannot restart', () => {
    const result = runHelper({ FAIL_RESTART: '1' })

    expect(result.status).toBe(1)
    expect(calls()).toContain('restart frank.service')
    expect(calls()).not.toContain('stop persistent-biometrics.mount')
    expect(existsSync(mountUnit)).toBe(true)
    expect(existsSync(recoveryTool)).toBe(true)
  })

  it('preserves recovery tools when the mount remains active after stop', () => {
    const result = runHelper({ STOP_LEAVES_MOUNTED: '1' })

    expect(result.status).toBe(1)
    expect(calls()).toContain('stop persistent-biometrics.mount')
    expect(result.stderr).toContain('is still mounted')
    expect(existsSync(mountUnit)).toBe(true)
    expect(existsSync(recoveryTool)).toBe(true)
  })
})
