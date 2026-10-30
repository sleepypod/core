// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const maintenanceHelpers = resolve('scripts/lib/maintenance-helpers')

let root: string
let installDir: string

function stub(path: string, body: string) {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

function telemetryHelpers(blockBody: string) {
  mkdirSync(join(installDir, 'scripts/lib'), { recursive: true })
  writeFileSync(join(installDir, 'scripts/lib/telemetry-helpers'), `
block_stock_telemetry() { echo "block_stock_telemetry $1" >> "$ROOT/calls.log"; ${blockBody}; }
apply_dns_blackhole() { echo "apply_dns_blackhole $1" >> "$ROOT/calls.log"; }
`)
}

/** What a v3.5.0 sp-update does after the download: source the new tree's helper under set -e. */
function runOldUpdaterStep(extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail
source "${maintenanceHelpers}"
install_maintenance_timer
echo "update continued"`], {
    env: { ...process.env, ROOT: root, INSTALL_DIR: installDir, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ...extraEnv },
    encoding: 'utf8',
  })
}

function calls(): string[] {
  try {
    return readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n')
  }
  catch {
    return []
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maintenance-telemetry-'))
  installDir = join(root, 'app')
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(installDir, 'scripts/systemd'), { recursive: true })
  stub(join(root, 'bin/install'), 'echo "install $*" >> "$ROOT/calls.log"')
  stub(join(root, 'bin/systemctl'), 'echo "systemctl $*" >> "$ROOT/calls.log"')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('install_maintenance_timer telemetry reconcile', () => {
  it('blocks stock telemetry from the new tree, so an older updater applies it on the first update', () => {
    telemetryHelpers('true')
    const run = runOldUpdaterStep()
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('update continued')
    const log = calls()
    const timer = log.findIndex(l => l.startsWith('systemctl enable --now sleepypod-maintenance.timer'))
    expect(timer).toBeGreaterThanOrEqual(0)
    expect(log.slice(timer + 1)).toEqual([
      `block_stock_telemetry ${installDir}`,
      `apply_dns_blackhole ${installDir}`,
    ])
  })

  it('still applies the DNS blackhole and continues the update when blocking fails', () => {
    telemetryHelpers('return 1')
    const run = runOldUpdaterStep()
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('update continued')
    expect(calls()).toContain(`apply_dns_blackhole ${installDir}`)
  })

  it('warns and continues the update when the helpers are broken', () => {
    mkdirSync(join(installDir, 'scripts/lib'), { recursive: true })
    writeFileSync(join(installDir, 'scripts/lib/telemetry-helpers'), 'block_stock_telemetry() {\n')
    const run = runOldUpdaterStep()
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('update continued')
    expect(run.stderr).toContain('Eight Sleep telemetry blocking failed (continuing)')
  })

  it('removes an existing managed /etc/hosts block with the new tree\'s real helpers', () => {
    mkdirSync(join(installDir, 'scripts/lib'), { recursive: true })
    copyFileSync(resolve('scripts/lib/telemetry-helpers'), join(installDir, 'scripts/lib/telemetry-helpers'))
    copyFileSync(resolve('scripts/internet-control'), join(installDir, 'scripts/internet-control'))
    const hosts = join(root, 'etc/hosts')
    mkdirSync(join(root, 'etc'), { recursive: true })
    writeFileSync(hosts, '127.0.0.1 localhost\n\n# BEGIN sleepypod-telemetry-block\n0.0.0.0 raw-api-upload.8slp.net\n# END sleepypod-telemetry-block\n')
    const run = runOldUpdaterStep({ INTERNET_CONTROL_ROOT: root, VECTOR_DATA_DIR: join(root, 'vector') })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('update continued')
    expect(readFileSync(hosts, 'utf8')).toBe('127.0.0.1 localhost\n')
    expect(readFileSync(`${hosts}.bak.sleepypod`, 'utf8')).toContain('0.0.0.0 raw-api-upload.8slp.net')
  })

  it('does nothing when the tree has no telemetry helpers', () => {
    const run = runOldUpdaterStep()
    expect(run.status).toBe(0)
    expect(calls().some(l => l.startsWith('block_stock_telemetry'))).toBe(false)
  })
})

describe('install_maintenance_timer saved internet access restore', () => {
  const dropIn = () => join(root, 'etc/systemd/system/sleepypod.service.d/iptables-saved-choice.conf')
  const copy = () => join(root, 'usr/local/bin/sp-internet-control')

  /** The new tree's real helper; install(1) only really writes inside the sandbox root. */
  function choiceTree() {
    mkdirSync(join(installDir, 'scripts/lib'), { recursive: true })
    copyFileSync(resolve('scripts/lib/internet-choice-helpers'), join(installDir, 'scripts/lib/internet-choice-helpers'))
    writeFileSync(join(installDir, 'scripts/internet-control'), '#!/bin/bash\necho control\n')
    stub(join(root, 'bin/install'), `echo "install $*" >> "$ROOT/calls.log"
case "$*" in *"$ROOT/usr/local/bin/"*) exec /usr/bin/install "$@" ;; esac`)
    stub(join(root, 'bin/chown'), 'echo "chown $*" >> "$ROOT/calls.log"')
  }

  /** An older updater's step, with every path the helper writes under the sandbox root. */
  function runSandboxed() {
    return spawnSync('bash', ['-c', `set -euo pipefail
source "${maintenanceHelpers}"
install_maintenance_timer
echo "update continued"`], {
      env: { ...process.env, ROOT: root, SLEEPYPOD_ROOT: root, INSTALL_DIR: installDir, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    })
  }

  it('writes the drop-in and a root-owned copy on an older updater\'s first update', () => {
    choiceTree()
    const run = runSandboxed()
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('update continued')
    expect(readFileSync(dropIn(), 'utf8')).toBe(
      '[Service]\nExecStartPre=+/bin/sh -c \'PATH=/usr/sbin:/sbin:/usr/bin:/bin /usr/local/bin/sp-internet-control restore; true\'\n',
    )
    expect(readFileSync(copy(), 'utf8')).toBe('#!/bin/bash\necho control\n')
    expect(statSync(copy()).mode & 0o7777).toBe(0o755)
    expect(calls()).toContain(`chown root:root ${copy()}`)
  })

  it('reloads systemd for the drop-in only when it is written', () => {
    choiceTree()
    expect(runSandboxed().status).toBe(0)
    const reloads = () => calls().filter(l => l === 'systemctl daemon-reload').length
    // First run: the timer's reload plus the drop-in's.
    expect(reloads()).toBe(2)
    expect(runSandboxed().status).toBe(0)
    expect(reloads()).toBe(3)
  })

  it('warns and continues the update when the helper is broken', () => {
    mkdirSync(join(installDir, 'scripts/lib'), { recursive: true })
    writeFileSync(join(installDir, 'scripts/lib/internet-choice-helpers'), 'install_internet_choice_restore() {\n')
    const run = runSandboxed()
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('update continued')
    expect(run.stderr).toContain('saved internet access restore setup failed (continuing)')
  })

  it('warns, writes no drop-in, and continues when the copy cannot be made root-owned', () => {
    choiceTree()
    stub(join(root, 'bin/chown'), 'exit 1')
    const run = runSandboxed()
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('update continued')
    expect(run.stderr).toContain('saved internet access restore setup failed (continuing)')
    expect(existsSync(dropIn())).toBe(false)
  })
})
