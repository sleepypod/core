import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SP_TEST_CALLS: calls, SLEEPYPOD_ROOT: join(dir, 'root') },
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

describe('maintenance stock firmware guard', () => {
  const BEGIN = '# BEGIN sleepypod-telemetry-block'
  const END = '# END sleepypod-telemetry-block'
  const ALL_UNITS = ['vector.service', 'telegraf.service', 'swupdate.socket', 'swupdate.service', 'swupdate-progress.service', 'defibrillator.service', 'eight-kernel.service']
  const FIRMWARE_UNITS = ['swupdate.socket', 'swupdate.service', 'swupdate-progress.service', 'defibrillator.service']

  /** sp-maintenance with a stub systemctl that logs and masks inside $SLEEPYPOD_ROOT. */
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'maintenance-guard-'))
    dirs.push(dir)
    const root = join(dir, 'root')
    const bin = join(dir, 'bin')
    for (const d of [bin, join(dir, 'data'), join(root, 'etc/systemd/system'), join(root, 'lib/systemd/system'), join(root, 'etc/sleepypod'), join(root, 'active')]) {
      mkdirSync(d, { recursive: true })
    }
    const command = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    command('getent', 'exit 1')
    command('du', 'echo "1 fixture"')
    command('df', 'printf "Filesystem 1M-blocks Used Available\\nfixture 100 20 80\\n"')
    command('journalctl', 'exit 0')
    command('pnpm', 'exit 0')
    command('systemctl', `echo "$*" >> "$SP_TEST_CALLS"
[ "$SP_TEST_SYSTEMCTL_FAIL" = 1 ] && exit 1
case "$1" in
  mask) ln -sfn /dev/null "$SLEEPYPOD_ROOT/etc/systemd/system/$2" ;;
  is-active) shift; for u in "$@"; do if [ -f "$SLEEPYPOD_ROOT/active/$u" ]; then echo active; else echo inactive; fi; done ;;
esac
exit 0`)
    const sudoers = join(dir, 'sudoers')
    writeFileSync(sudoers, 'sleepypod ALL=(root) NOPASSWD: /bin/systemctl reboot, /usr/bin/systemctl reboot')
    const filename = join(dir, 'maintenance')
    writeFileSync(filename, script
      .replaceAll('/etc/sleepypod/data-dir', join(dir, 'missing-pointer'))
      .replaceAll('/persistent/sleepypod-data', join(dir, 'data'))
      .replaceAll('/home/dac/sleepypod-core', dir)
      .replaceAll('/etc/sudoers.d/sleepypod-reboot', sudoers))
    const calls = join(dir, 'calls')
    writeFileSync(calls, '')
    const run = (args: string[] = [], extra: Record<string, string> = {}) => spawnSync('bash', [filename, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SP_TEST_CALLS: calls, SLEEPYPOD_ROOT: root, ...extra },
    })
    const log = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    const hosts = join(root, 'etc/hosts')
    const addUnit = (unit: string, active = false) => {
      writeFileSync(join(root, 'lib/systemd/system', unit), '[Unit]\n')
      if (active) writeFileSync(join(root, 'active', unit), '')
    }
    const masked = join(root, 'etc/systemd/system')
    const isMasked = (unit: string) => existsSync(join(masked, unit)) && readlinkSync(join(masked, unit)) === '/dev/null'
    return { root, run, log, hosts, addUnit, isMasked, calls }
  }

  it('startup removes the managed hosts block, keeps unrelated lines and a backup', () => {
    const { run, hosts } = setup()
    writeFileSync(hosts, `127.0.0.1 localhost\n\n${BEGIN}\n0.0.0.0 raw-api-upload.8slp.net\n0.0.0.0 device-api-ws.8slp.net\n${END}\n192.168.1.5 nas\n`)
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(hosts, 'utf8')).toBe('127.0.0.1 localhost\n\n192.168.1.5 nas\n')
    expect(readFileSync(`${hosts}.bak.sleepypod`, 'utf8')).toContain('0.0.0.0 raw-api-upload.8slp.net')
    expect(result.stdout).toContain('Removed the old Eight Sleep 0.0.0.0 block')
  })

  it('is a no-op without a block or units: no edit, no backup, no systemctl call', () => {
    const { run, hosts, log } = setup()
    writeFileSync(hosts, '127.0.0.1 localhost\n')
    expect(run(['--startup']).status).toBe(0)
    expect(readFileSync(hosts, 'utf8')).toBe('127.0.0.1 localhost\n')
    expect(existsSync(`${hosts}.bak.sleepypod`)).toBe(false)
    expect(log()).toEqual([])
  })

  it.each([
    ['a missing END', `127.0.0.1 localhost\n${BEGIN}\n0.0.0.0 api.8slp.net\n`],
    ['END before BEGIN', `127.0.0.1 localhost\n${END}\n0.0.0.0 api.8slp.net\n${BEGIN}\n`],
    ['two blocks', `${BEGIN}\n0.0.0.0 a.8slp.net\n${END}\n${BEGIN}\n0.0.0.0 b.8slp.net\n${END}\n`],
  ])('leaves malformed markers alone (%s) and still finishes', (_name, content) => {
    const { run, hosts } = setup()
    writeFileSync(hosts, content)
    const result = run()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('malformed sleepypod hosts markers')
    expect(readFileSync(hosts, 'utf8')).toBe(content)
    expect(result.stdout).toContain('Maintenance complete.')
  })

  it('masks every stock unit that exists, socket before service, and skips missing ones', () => {
    const { run, log, addUnit, isMasked } = setup()
    const present = ALL_UNITS.filter(u => u !== 'telegraf.service')
    for (const unit of present) addUnit(unit, true)
    addUnit('swupdate-usb@.service', true)
    addUnit('frankenfirmware.service', true)
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    for (const unit of present) {
      expect(log()).toContain(`disable --now --no-block ${unit}`)
      expect(isMasked(unit)).toBe(true)
    }
    expect(log().indexOf('mask swupdate.socket')).toBeLessThan(log().indexOf('disable --now --no-block swupdate.service'))
    expect(log().join('\n')).not.toMatch(/telegraf|swupdate-usb|frankenfirmware|capybara|dac|burrow/)
  })

  it('pays one systemctl call once everything is masked, and stops a masked unit that still runs', () => {
    const { run, log, addUnit, root, calls } = setup()
    for (const unit of ALL_UNITS) addUnit(unit)
    expect(run().status).toBe(0)
    writeFileSync(calls, '')
    expect(run().status).toBe(0)
    expect(log()).toEqual([`is-active ${ALL_UNITS.join(' ')}`])
    writeFileSync(join(root, 'active', 'swupdate.service'), '')
    writeFileSync(calls, '')
    expect(run().status).toBe(0)
    expect(log()).toEqual([`is-active ${ALL_UNITS.join(' ')}`, 'stop --no-block swupdate.service'])
  })

  it('leaves the updater and watchdog alone when the owner allowed firmware updates', () => {
    const { run, log, addUnit, isMasked, root } = setup()
    for (const unit of ALL_UNITS) addUnit(unit, true)
    writeFileSync(join(root, 'etc/sleepypod/firmware-updates'), 'allow\n')
    expect(run().status).toBe(0)
    for (const unit of FIRMWARE_UNITS) {
      expect(log().join('\n')).not.toContain(unit)
      expect(isMasked(unit)).toBe(false)
    }
    for (const unit of ['vector.service', 'telegraf.service', 'eight-kernel.service']) expect(isMasked(unit)).toBe(true)
    writeFileSync(join(root, 'etc/sleepypod/firmware-updates'), 'allowed\n')
    expect(run().status).toBe(0)
    for (const unit of FIRMWARE_UNITS) expect(isMasked(unit)).toBe(true)
  })

  it('never fails startup when systemctl fails', () => {
    const { run, addUnit } = setup()
    addUnit('swupdate.service', true)
    const result = run([], { SP_TEST_SYSTEMCTL_FAIL: '1' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('could not mask swupdate.service')
    expect(result.stdout).toContain('Maintenance complete.')
  })

  it('--housekeeping leaves hosts and units alone', () => {
    const { run, hosts, log, addUnit } = setup()
    const content = `127.0.0.1 localhost\n${BEGIN}\n0.0.0.0 api.8slp.net\n${END}\n`
    writeFileSync(hosts, content)
    for (const unit of ALL_UNITS) addUnit(unit, true)
    expect(run(['--housekeeping']).status).toBe(0)
    expect(readFileSync(hosts, 'utf8')).toBe(content)
    expect(log()).toEqual([])
  })

  it('keeps its unit lists equal to scripts/lib/telemetry-helpers and never sources the install tree', () => {
    const arrays = (source: string) => [...source.matchAll(/^(STOCK_[A-Z_]+_UNITS)=\((.*)\)$/gm)].map(m => `${m[1]}=${m[2]}`)
    const helpers = arrays(readFileSync('scripts/lib/telemetry-helpers', 'utf8'))
    expect(helpers).toHaveLength(3)
    expect(arrays(script)).toEqual(helpers)
    expect(script).not.toMatch(/^\s*(source|\.) /m)
    const code = script.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
    expect(code).not.toMatch(/dnsmasq|dns-block|resolv\.conf|sleepypod-core\/scripts/)
  })
})
