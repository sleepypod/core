// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
function runOldUpdaterStep() {
  return spawnSync('bash', ['-c', `set -euo pipefail
source "${maintenanceHelpers}"
install_maintenance_timer
echo "update continued"`], {
    env: { ...process.env, ROOT: root, INSTALL_DIR: installDir, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
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

  it('does nothing when the tree has no telemetry helpers', () => {
    const run = runOldUpdaterStep()
    expect(run.status).toBe(0)
    expect(calls().some(l => l.startsWith('block_stock_telemetry'))).toBe(false)
  })
})
