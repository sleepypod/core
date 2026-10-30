// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  is-active) [ "$2" = --quiet ] && shift; [ -f "$u/$2.active" ] || { [ "$#" -lt 2 ] || echo inactive; exit 3; }; echo active ;;
  enable) echo enabled > "$u/$2" ;;
  disable) rm -f "$u/$3.active"; echo disabled > "$u/$3" ;;
  mask) echo masked > "$u/$2" ;;
  stop) rm -f "$u/$2.active" ;;
  restart)
    [ "$2" = sleepypod-dns.service ] || exit 0
    [ -f "$ROOT/dns-start-fails" ] && exit 1
    [ -f "$ROOT/drop-wifi-on-start" ] && : > "$ROOT/dns-down"
    : > "$u/$2.active" ;;
esac`

/**
 * busybox-style nslookup NAME [SERVER]. Our dnsmasq (server 127.0.0.1, or the
 * system resolver while resolv.conf points at ours) answers only while its
 * unit is active; it blackholes 8slp.net. dns-down breaks upstream lookups.
 */
const NSLOOKUP = `
printf 'Server:\\t\\t127.0.0.1\\nAddress:\\t127.0.0.1:53\\n\\n'
fail() { echo "** server can't find $1: NXDOMAIN"; exit 1; }
via_dnsmasq=false
if [ "\${2:-}" = 127.0.0.1 ]; then via_dnsmasq=true
elif [ -z "\${2:-}" ] && [ "$(readlink "$ROOT/etc/resolv.conf")" = /etc/sleepypod/resolv.conf ]; then via_dnsmasq=true; fi
if [ "$via_dnsmasq" = true ]; then
  [ -f "$ROOT/units/sleepypod-dns.service.active" ] && [ ! -f "$ROOT/dnsmasq-broken" ] || fail "$1"
fi
case "$1" in
  *8slp.net) [ "$via_dnsmasq" = true ] || fail "$1"; printf 'Name:\\t%s\\nAddress: 0.0.0.0\\n' "$1" ;;
  *) [ -f "$ROOT/dns-down" ] && fail "$1"; printf 'Non-authoritative answer:\\nName:\\t%s\\nAddress: 140.82.112.3\\n' "$1" ;;
esac`

const env = () => ({ ...process.env, INTERNET_CONTROL_ROOT: root, ROOT: root, PATH: `${bin}:/usr/bin:/bin` })

function run(command: string) {
  return spawnSync('/bin/bash', [controlScript, command], { encoding: 'utf8', env: env() })
}

const ORIGINAL_RESOLV = '/etc/resolv-conf.NetworkManager'
const OUR_RESOLV = '/etc/sleepypod/resolv.conf'
const hostsPath = () => join(root, 'etc', 'hosts')
const hosts = () => readFileSync(hostsPath(), 'utf8')
const systemctlLog = () => existsSync(join(root, 'systemctl.log')) ? readFileSync(join(root, 'systemctl.log'), 'utf8') : ''
const resolvTarget = () => readlinkSync(join(root, 'etc', 'resolv.conf'))
const sp = (name: string) => join(root, 'etc', 'sleepypod', name)
const unitFile = () => join(root, 'etc', 'systemd', 'system', 'sleepypod-dns.service')
const legacyNm = () => [join(root, 'etc', 'NetworkManager', 'conf.d', 'sleepypod-dns.conf'), join(root, 'etc', 'NetworkManager', 'dnsmasq.d', 'sleepypod-block.conf')]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-telemetry-'))
  bin = join(root, 'bin')
  for (const dir of [bin, join(root, 'etc', 'NetworkManager'), join(root, 'usr', 'bin'), join(root, 'units'), join(root, 'run', 'NetworkManager')]) {
    mkdirSync(dir, { recursive: true })
  }
  stub(join(bin, 'systemctl'), SYSTEMCTL)
  stub(join(bin, 'nslookup'), NSLOOKUP)
  stub(join(bin, 'ping'), 'exit 2')
  stub(join(bin, 'sleep'), 'exit 0')
  stub(join(root, 'usr', 'bin', 'dnsmasq'), 'exit 0')
  writeFileSync(join(root, 'run', 'NetworkManager', 'no-stub-resolv.conf'), 'nameserver 192.168.1.123\n')
  // Pod 5: rc-manager=symlink
  symlinkSync(ORIGINAL_RESOLV, join(root, 'etc', 'resolv.conf'))
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
  it('runs its own dnsmasq on 127.0.0.1 and repoints resolv.conf only after it answers', () => {
    const result = run('dns-block')
    expect(result.status, result.stderr).toBe(0)
    const conf = readFileSync(sp('dnsmasq.conf'), 'utf8')
    for (const line of ['listen-address=127.0.0.1', 'bind-interfaces', 'port=53', 'resolv-file=/run/NetworkManager/no-stub-resolv.conf', 'cache-size=1000',
      'address=/8slp.net/0.0.0.0', 'address=/8slp.net/::', 'address=/kinesis.us-east-1.amazonaws.com/0.0.0.0', 'address=/kinesis.us-east-1.amazonaws.com/::']) {
      expect(conf.split('\n')).toContain(line)
    }
    expect(conf).not.toMatch(/dhcp|tftp|no-hosts/)
    const unit = readFileSync(unitFile(), 'utf8')
    expect(unit).toContain('ExecStart=/usr/bin/dnsmasq -k --conf-file=/etc/sleepypod/dnsmasq.conf\n')
    expect(unit).toContain('Restart=always\n')
    expect(readFileSync(sp('resolv.conf'), 'utf8')).toBe('nameserver 127.0.0.1\n')
    expect(readFileSync(sp('resolv.conf.orig-target'), 'utf8')).toBe(`${ORIGINAL_RESOLV}\n`)
    expect(resolvTarget()).toBe(OUR_RESOLV)
    const log = systemctlLog()
    expect(log).toContain('enable sleepypod-dns.service')
    expect(log).not.toContain('NetworkManager')
    expect(legacyNm().some(file => existsSync(file))).toBe(false)

    expect(run('dns-block').stdout).toContain('already up to date')
    expect(systemctlLog().match(/restart sleepypod-dns.service/g)).toHaveLength(1)
  })

  it('rolls back when dnsmasq does not answer: original resolv.conf first, then the unit, then waits for DNS', () => {
    writeFileSync(join(root, 'dnsmasq-broken'), '')
    const result = run('dns-block')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Rolling back')
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(systemctlLog()).toContain('disable --now sleepypod-dns.service')
    expect(existsSync(unitFile()) || existsSync(sp('dnsmasq.conf')) || existsSync(sp('resolv.conf.orig-target'))).toBe(false)
    expect(result.stdout).toContain('DNS works: github.com resolves')
  })

  it('rolls back when the unit fails to start', () => {
    writeFileSync(join(root, 'dns-start-fails'), '')
    expect(run('dns-block').status).not.toBe(0)
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(existsSync(unitFile())).toBe(false)
  })

  it('reports when DNS is still down after the rollback wait', () => {
    writeFileSync(join(root, 'drop-wifi-on-start'), '')
    const result = run('dns-block')
    expect(result.status).not.toBe(0)
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(result.stderr).toContain('github.com still does not resolve after 60s')
  })

  it('starts nothing when DNS already fails, since the blackhole could not be verified', () => {
    writeFileSync(join(root, 'dns-down'), '')
    const result = run('dns-block')
    expect(result.status).not.toBe(0)
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(systemctlLog()).not.toMatch(/restart|enable/)
    expect(existsSync(unitFile())).toBe(false)
  })

  it.each([
    ['dnsmasq is missing', () => rmSync(join(root, 'usr', 'bin', 'dnsmasq')), 'dnsmasq not found'],
    ['NetworkManager has no upstream file', () => rmSync(join(root, 'run', 'NetworkManager', 'no-stub-resolv.conf')), 'no-stub-resolv.conf not found'],
    ['resolv.conf is a regular file', () => {
      rmSync(join(root, 'etc', 'resolv.conf'))
      writeFileSync(join(root, 'etc', 'resolv.conf'), 'nameserver 192.168.1.123\n')
    }, 'is not a symlink'],
    ['port 53 is taken', () => {
      mkdirSync(join(root, 'proc', 'net'), { recursive: true })
      writeFileSync(join(root, 'proc', 'net', 'udp'), '  sl  local_address rem_address   st\n   0: 0100007F:0035 00000000:0000 07\n')
    }, 'already listens on port 53'],
  ])('skips the layer and succeeds when %s', (_name, arrange, message) => {
    arrange()
    const result = run('dns-block')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(message)
    expect(result.stdout).toContain('/etc/hosts fallback in use')
    expect(systemctlLog()).not.toMatch(/restart|enable/)
    expect(existsSync(unitFile())).toBe(false)
  })

  it('removes the old NetworkManager dns=dnsmasq drop-ins', () => {
    for (const file of legacyNm()) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '[main]\ndns=dnsmasq\n')
    }
    expect(run('dns-block').status).toBe(0)
    expect(legacyNm().some(file => existsSync(file))).toBe(false)
    expect(systemctlLog().match(/restart NetworkManager.service/g)).toHaveLength(1)
  })

  it('dns-unblock restores resolv.conf, then stops and disables the unit', () => {
    run('dns-block')
    const result = run('dns-unblock')
    expect(result.status).toBe(0)
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(systemctlLog()).toContain('disable --now sleepypod-dns.service')
    expect(existsSync(unitFile()) || existsSync(sp('dns-resolv-hook'))).toBe(false)
    expect(result.stdout).toContain('DNS works')
  })

  it('puts the original resolv.conf back before starting when a power cut left it on 127.0.0.1', () => {
    run('dns-block')
    rmSync(join(root, 'units', 'sleepypod-dns.service.active'))
    writeFileSync(join(root, 'dnsmasq-broken'), '')
    run('dns-block')
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
  })
})

describe('sleepypod-dns watchdog hooks', () => {
  const hook = (action: 'up' | 'down') => spawnSync('/bin/sh', [sp('dns-resolv-hook'), action], { encoding: 'utf8', env: env() })

  it('wires the hooks so resolv.conf follows dnsmasq', () => {
    run('dns-block')
    const unit = readFileSync(unitFile(), 'utf8')
    expect(unit).toContain('ExecStartPre=/bin/sh /etc/sleepypod/dns-resolv-hook down\n')
    expect(unit).toContain('ExecStartPost=/bin/sh /etc/sleepypod/dns-resolv-hook up\n')
    expect(unit).toContain('ExecStopPost=/bin/sh /etc/sleepypod/dns-resolv-hook down\n')
  })

  it('stop hook restores the original resolver when dnsmasq dies', () => {
    run('dns-block')
    rmSync(join(root, 'units', 'sleepypod-dns.service.active'))
    expect(hook('down').status).toBe(0)
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(hook('down').status).toBe(0)
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
  })

  it('start hook repoints only after a successful probe, and fails the start otherwise', () => {
    run('dns-block')
    hook('down')
    writeFileSync(join(root, 'dnsmasq-broken'), '')
    const failed = hook('up')
    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain('not answering on 127.0.0.1')
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    rmSync(join(root, 'dnsmasq-broken'))
    expect(hook('up').status).toBe(0)
    expect(resolvTarget()).toBe(OUR_RESOLV)
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
    rmSync(join(root, 'units', 'sleepypod-dns.service.active'))
    const stopped = run('status').stdout
    expect(stopped).toMatch(/\/etc\/hosts only/)
    expect(stopped).toContain('dnsmasq layer:       configured but not in use')
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

  it('keep DNS out of the early pass and swap resolv.conf only after every download', () => {
    const helperSource = readFileSync(helpers, 'utf8')
    const early = helperSource.match(/^block_stock_telemetry\(\) \{[\s\S]*?\n\}/m)?.[0] ?? ''
    const hostsOnly = helperSource.match(/^apply_name_blocking\(\) \{[\s\S]*?\n\}/m)?.[0] ?? ''
    expect(early).toContain('apply_name_blocking')
    expect(early + hostsOnly).not.toContain('dns-block')
    expect(helperSource).toMatch(/^apply_dns_blackhole\(\) \{[\s\S]*?dns-block[\s\S]*?return 0\n\}/m)

    const lastIndex = (s: string, needle: string) => s.lastIndexOf(needle)
    const dnsCall = 'apply_dns_blackhole "$INSTALL_DIR" || true'
    // sp-update: after pnpm install, the module uv sync and its uv download; before re-blocking WAN and starting.
    expect(updateScript.split(dnsCall)).toHaveLength(2)
    for (const download of ['CI=true pnpm install', 'uv sync', 'curl -LsSf https://astral.sh/uv/install.sh']) {
      expect(updateScript.indexOf(dnsCall)).toBeGreaterThan(lastIndex(updateScript, download))
    }
    expect(updateScript.indexOf(dnsCall)).toBeLessThan(updateScript.indexOf('echo "Starting service..."'))
    // install: after its last download; the cleanup trap restores WAN afterwards.
    expect(installScript.split(dnsCall)).toHaveLength(2)
    for (const download of ['CI=true pnpm install', 'uv sync', 'uv cache clean', 'install.sh']) {
      expect(installScript.indexOf(dnsCall)).toBeGreaterThan(lastIndex(installScript.slice(0, installScript.indexOf('# Optional SSH configuration')), download))
    }
  })
})
