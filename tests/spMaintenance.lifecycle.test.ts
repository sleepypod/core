import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = readFileSync('scripts/bin/sp-maintenance', 'utf8')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('maintenance startup separation', () => {
  it.each(['default', '--startup', '--housekeeping'])('runs expensive commands only for housekeeping (%s)', (mode) => {
    const args = mode === 'default' ? [] : [mode]
    const dir = mkdtempSync(join(tmpdir(), 'maintenance-lifecycle-'))
    dirs.push(dir)
    const old = new Date(Date.now() - 7 * 86_400_000)
    const active = join(dir, 'staging-active')
    const stale = join(dir, 'staging-stale')
    for (const staging of [active, stale]) {
      mkdirSync(join(staging, 'nested'), { recursive: true })
      const child = join(staging, 'nested', 'download')
      writeFileSync(child, 'in-progress download')
      if (staging === stale) utimesSync(child, old, old)
      utimesSync(join(staging, 'nested'), old, old)
      utimesSync(staging, old, old)
    }
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    mkdirSync(join(dir, 'data'))
    const calls = join(dir, 'calls')
    writeFileSync(calls, '')
    const command = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    }
    command('getent', 'exit 1') // This fixture has no DAC group.
    command('du', 'echo "120 fixture"')
    command('df', 'printf "Filesystem 1M-blocks Used Available\\nfixture 100 20 80\\n"')
    command('journalctl', 'echo journal >> "$SP_TEST_CALLS"')
    command('pnpm', 'echo pnpm >> "$SP_TEST_CALLS"')
    const sudoers = join(dir, 'sudoers')
    writeFileSync(sudoers, 'sleepypod ALL=(root) NOPASSWD: /bin/systemctl reboot, /usr/bin/systemctl reboot')
    const isolated = script
      .replaceAll('/etc/sleepypod/data-dir', join(dir, 'missing-pointer'))
      .replaceAll('/persistent/sleepypod-data', join(dir, 'data'))
      .replaceAll('/home/dac/sleepypod-core', dir)
      .replaceAll('/etc/sudoers.d/sleepypod-reboot', sudoers)
      .replace('for d in /tmp/tmp.* /tmp/sleepypod-* /tmp/sp-* /tmp/core-*;', `for d in ${dir}/staging-*;`)
    const filename = join(dir, 'maintenance')
    writeFileSync(filename, isolated)
    execFileSync('bash', [filename, ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SP_TEST_CALLS: calls },
    })
    expect(existsSync(active)).toBe(true)
    expect(existsSync(stale)).toBe(mode !== '--housekeeping')
    expect(readFileSync(calls, 'utf8')).toBe(args.includes('--housekeeping') ? 'journal\npnpm\n' : '')
  })

  it('installs the deferred timer on fresh and OTA installs and removes it on uninstall', () => {
    for (const filename of ['scripts/install', 'scripts/bin/sp-update']) {
      expect(readFileSync(filename, 'utf8')).toContain('install_maintenance_timer')
    }
    const timer = readFileSync('scripts/systemd/sleepypod-maintenance.timer', 'utf8')
    // A new OTA timer on an already-running Pod must not immediately prune.
    expect(timer).toContain('OnActiveSec=10min')
    expect(timer).toContain('OnUnitActiveSec=1d')
    expect(readFileSync('scripts/bin/sp-uninstall', 'utf8')).toContain('sleepypod-maintenance.timer')
  })
})
