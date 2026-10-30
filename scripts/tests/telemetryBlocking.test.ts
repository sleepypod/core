// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const controlScript = resolve('scripts/internet-control')
const helpers = resolve('scripts/lib/telemetry-helpers')
const installScript = readFileSync(resolve('scripts/install'), 'utf8')
const updateScript = readFileSync(resolve('scripts/bin/sp-update'), 'utf8')

const BEGIN = '# BEGIN sleepypod-telemetry-block'
const END = '# END sleepypod-telemetry-block'

function arrayEntries(name: string): string[] {
  const body = readFileSync(controlScript, 'utf8').match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)\\n\\)`, 'm'))?.[1]
  if (!body) throw new Error(`${name} not found in internet-control`)
  return [...body.matchAll(/^\s*"([^"]+)"/gm)].map(m => m[1])
}
const DOMAINS = arrayEntries('EIGHTSLEEP_DOMAINS')

let root: string
let bin: string

function stub(path: string, body: string) {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

/** systemctl backed by $ROOT/units/<unit> (enablement) and <unit>.active files. */
const SYSTEMCTL = `
echo "$*" >> "$ROOT/systemctl.log"
u="$ROOT/units"
case "$1" in
  is-enabled) [ -f "$u/$2" ] && { cat "$u/$2"; [ "$(cat "$u/$2")" != masked ] && exit 0; }; exit 1 ;;
  is-active) [ "$2" = --quiet ] && shift; [ -f "$u/$2.active" ] ;;
  disable) rm -f "$u/$3.active"; echo disabled > "$u/$3" ;;
  mask) echo masked > "$u/$2" ;;
  stop) rm -f "$u/$2.active" ;;
  restart) exit 0 ;;
esac`

/** busybox-style nslookup: dnsmasq answers only while its config exists. */
const NSLOOKUP = `
printf 'Server:\\t\\t127.0.0.1\\nAddress:\\t127.0.0.1:53\\n\\n'
conf="$ROOT/etc/NetworkManager/dnsmasq.d/sleepypod-block.conf"
fail() { echo "** server can't find $1: NXDOMAIN"; exit 1; }
[ -f "$ROOT/dns-down" ] && fail "$1"
[ -f "$ROOT/dns-broken" ] && [ -f "$conf" ] && fail "$1"
case "$1" in
  *8slp.net) [ -f "$conf" ] || fail "$1"; printf 'Name:\\t%s\\nAddress: 0.0.0.0\\n' "$1" ;;
  *) printf 'Non-authoritative answer:\\nName:\\t%s\\nAddress: 140.82.112.3\\n' "$1" ;;
esac`

function run(command: string) {
  return spawnSync('/bin/bash', [controlScript, command], {
    encoding: 'utf8',
    env: { ...process.env, INTERNET_CONTROL_ROOT: root, ROOT: root, PATH: `${bin}:/usr/bin:/bin` },
  })
}

const hostsPath = () => join(root, 'etc', 'hosts')
const hosts = () => readFileSync(hostsPath(), 'utf8')
const systemctlLog = () => existsSync(join(root, 'systemctl.log')) ? readFileSync(join(root, 'systemctl.log'), 'utf8') : ''
const nmConf = () => join(root, 'etc', 'NetworkManager', 'conf.d', 'sleepypod-dns.conf')
const blockConf = () => join(root, 'etc', 'NetworkManager', 'dnsmasq.d', 'sleepypod-block.conf')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-telemetry-'))
  bin = join(root, 'bin')
  for (const dir of [bin, join(root, 'etc', 'NetworkManager'), join(root, 'usr', 'sbin'), join(root, 'units')]) {
    mkdirSync(dir, { recursive: true })
  }
  stub(join(bin, 'systemctl'), SYSTEMCTL)
  stub(join(bin, 'nslookup'), NSLOOKUP)
  stub(join(bin, 'ping'), 'exit 2')
  stub(join(bin, 'sleep'), 'exit 0')
  stub(join(root, 'usr', 'sbin', 'dnsmasq'), 'exit 0')
  stub(join(root, 'usr', 'sbin', 'NetworkManager'), 'exit 0')
  writeFileSync(hostsPath(), '127.0.0.1 localhost\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('internet-control hosts-block', () => {
  it('blocks the swupdate and dac API names and the vector Kinesis endpoint', () => {
    expect(DOMAINS).toEqual(expect.arrayContaining(['update-api.8slp.net', 'device-api.8slp.net', 'raw-api-upload.8slp.net', 'kinesis.us-east-1.amazonaws.com']))
    expect(DOMAINS).toHaveLength(8)
  })

  it('rewrites an existing block in place when the domain list changed', () => {
    const old = ['raw-api-upload.8slp.net', 'device-api-ws.8slp.net', 'api.8slp.net', 'app-api.8slp.net', 'client-api.8slp.net']
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n\n${BEGIN}\n${old.map(d => `0.0.0.0 ${d}`).join('\n')}\n${END}\n192.168.1.5 nas\n`)
    const result = run('hosts-block')
    expect(result.status, result.stderr).toBe(0)
    const lines = hosts().split('\n')
    expect(lines.filter(l => l.startsWith('0.0.0.0 '))).toEqual(DOMAINS.map(d => `0.0.0.0 ${d}`))
    expect(lines.filter(l => l === BEGIN)).toHaveLength(1)
    expect(lines.indexOf(BEGIN)).toBeLessThan(lines.indexOf('192.168.1.5 nas'))
    expect(lines[0]).toBe('127.0.0.1 localhost')
    expect(readFileSync(`${hostsPath()}.bak.sleepypod`, 'utf8')).toContain('0.0.0.0 client-api.8slp.net')
  })

  it('repairs a block whose markers survived without any entries', () => {
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n${BEGIN}\n${END}\n`)
    expect(run('hosts-block').status).toBe(0)
    expect(hosts().split('\n').filter(l => l.startsWith('0.0.0.0 '))).toHaveLength(DOMAINS.length)
  })

  it('leaves an up-to-date block alone', () => {
    expect(run('hosts-block').status).toBe(0)
    const before = hosts()
    const mtime = statSync(hostsPath()).mtimeMs
    rmSync(`${hostsPath()}.bak.sleepypod`)
    const result = run('hosts-block')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already up to date')
    expect(hosts()).toBe(before)
    expect(statSync(hostsPath()).mtimeMs).toBe(mtime)
    expect(existsSync(`${hostsPath()}.bak.sleepypod`)).toBe(false)
  })
})

describe('internet-control dns-block', () => {
  it('blackholes every 8slp.net name and kinesis, restarting NetworkManager once', () => {
    const result = run('dns-block')
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(nmConf(), 'utf8')).toMatch(/^\[main\]\ndns=dnsmasq$/m)
    const block = readFileSync(blockConf(), 'utf8')
    for (const line of ['address=/8slp.net/0.0.0.0', 'address=/8slp.net/::', 'address=/kinesis.us-east-1.amazonaws.com/0.0.0.0', 'address=/kinesis.us-east-1.amazonaws.com/::']) {
      expect(block).toContain(line)
    }
    expect(run('dns-block').stdout).toContain('already up to date')
    expect(systemctlLog().match(/restart NetworkManager/g)).toHaveLength(1)
  })

  it('removes both files and restarts NetworkManager again when DNS breaks', () => {
    writeFileSync(join(root, 'dns-broken'), '')
    const result = run('dns-block')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Rolling back')
    expect(existsSync(nmConf())).toBe(false)
    expect(existsSync(blockConf())).toBe(false)
    expect(systemctlLog().match(/restart NetworkManager/g)).toHaveLength(2)
  })

  it('changes nothing when DNS already fails, since the switch could not be verified', () => {
    writeFileSync(join(root, 'dns-down'), '')
    const result = run('dns-block')
    expect(result.status).not.toBe(0)
    expect(existsSync(nmConf())).toBe(false)
    expect(systemctlLog()).toBe('')
  })

  it('falls back to /etc/hosts and succeeds on pods without dnsmasq', () => {
    rmSync(join(root, 'usr', 'sbin', 'dnsmasq'))
    const result = run('dns-block')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('/etc/hosts fallback in use')
    expect(existsSync(nmConf())).toBe(false)
    expect(systemctlLog()).toBe('')
  })

  it('dns-unblock removes the files and restarts NetworkManager', () => {
    run('dns-block')
    expect(run('dns-unblock').status).toBe(0)
    expect(existsSync(nmConf()) || existsSync(blockConf())).toBe(false)
    expect(systemctlLog().match(/restart NetworkManager/g)).toHaveLength(2)
  })
})

describe('internet-control status', () => {
  it('names the active name-blocking layer and the telemetry service state', () => {
    writeFileSync(join(root, 'units', 'vector.service'), 'masked')
    expect(run('status').stdout).toMatch(/Layer 2 \(names\): +INACTIVE/)
    run('hosts-block')
    expect(run('status').stdout).toMatch(new RegExp(`Layer 2 \\(names\\): +ACTIVE — /etc/hosts only \\(${DOMAINS.length} domains`))
    run('dns-block')
    const out = run('status').stdout
    expect(out).toMatch(/ACTIVE — dnsmasq wildcard \(8slp\.net kinesis\.us-east-1\.amazonaws\.com\) \+ \/etc\/hosts/)
    expect(out).toContain('vector masked, telegraf not installed')
  })
})

describe('stock telemetry services', () => {
  function disableTwice(vectorDir: string) {
    const script = `source ${helpers}; disable_stock_telemetry; echo --- >> "$ROOT/systemctl.log"; disable_stock_telemetry`
    return spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, ROOT: root, VECTOR_DATA_DIR: vectorDir, PATH: `${bin}:/usr/bin:/bin` },
    })
  }

  it('disables, stops and masks vector and telegraf once, then clears the vector buffer', () => {
    for (const unit of ['vector.service', 'telegraf.service', 'frankenfirmware.service', 'dac.service']) {
      writeFileSync(join(root, 'units', unit), 'enabled')
      writeFileSync(join(root, 'units', `${unit}.active`), '')
    }
    const vectorDir = join(root, 'persistent', 'vector')
    mkdirSync(join(vectorDir, 'buffer'), { recursive: true })
    writeFileSync(join(vectorDir, 'buffer', 'chunk'), 'x')

    const result = disableTwice(vectorDir)
    expect(result.status, result.stderr).toBe(0)
    const [first, second] = systemctlLog().split('---\n')
    expect(first).toContain('disable --now vector.service')
    expect(first).toContain('mask vector.service')
    expect(first).toContain('mask telegraf.service')
    expect(second).not.toMatch(/disable|mask|stop/)
    expect(systemctlLog()).not.toMatch(/frankenfirmware|dac|capybara|swupdate/i)
    expect(readFileSync(join(root, 'units', 'vector.service'), 'utf8').trim()).toBe('masked')
    expect(existsSync(join(root, 'units', 'vector.service.active'))).toBe(false)
    expect(existsSync(join(root, 'units', 'frankenfirmware.service.active'))).toBe(true)
    expect(readdirSync(vectorDir)).toEqual([])
  })

  it('stops a unit that was masked by hand but is still running', () => {
    writeFileSync(join(root, 'units', 'vector.service'), 'masked')
    writeFileSync(join(root, 'units', 'vector.service.active'), '')
    expect(disableTwice(join(root, 'none')).status).toBe(0)
    expect(systemctlLog()).toContain('stop vector.service')
    expect(systemctlLog()).not.toContain('mask vector.service')
  })

  it('is a no-op on pods without the units', () => {
    const result = disableTwice(join(root, 'none'))
    expect(result.status, result.stderr).toBe(0)
    expect(systemctlLog()).not.toMatch(/disable|mask|stop/)
  })
})

describe('install and sp-update wiring', () => {
  it('block telemetry before anything opens WAN, whatever its state, and again from the new code', () => {
    for (const [script, opener] of [[installScript, /^\s+unblock_wan$/m], [updateScript, /^\s*open_update_wan$/m]] as const) {
      const calls = [...script.matchAll(/^block_stock_telemetry_from "\$(?:PWD|INSTALL_DIR)"/gm)].map(m => m.index ?? 0)
      const firstOpen = script.search(opener)
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(firstOpen).toBeGreaterThan(0)
      expect(calls[0]).toBeLessThan(firstOpen)
      expect(script).not.toContain('grep -q "# BEGIN sleepypod-telemetry-block"')
    }
    const definition = (s: string) => s.match(/^block_stock_telemetry_from\(\) \{[\s\S]*?\n\}\n/m)?.[0]
    expect(definition(installScript)).toBeDefined()
    expect(definition(updateScript)).toBe(definition(installScript))
  })
})
