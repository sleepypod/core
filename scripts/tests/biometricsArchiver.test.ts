// @vitest-environment node

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const helperPath = resolve('scripts/lib/biometrics-archiver-helpers')
const archiverScript = resolve('modules/biometrics-archiver/sleepypod-biometrics-archiver')

let root: string
let tmpfsDir: string
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

function writeRaw(name = '00001.RAW'): string {
  const path = join(tmpfsDir, name)
  writeFileSync(path, 'sensor frame')
  return path
}

function calls(): string {
  return existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''
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

describe('sleepypod-biometrics-archiver', () => {
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
