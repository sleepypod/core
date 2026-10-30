// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const controlScript = resolve('scripts/internet-control')
const helpers = resolve('scripts/lib/telemetry-helpers')
const installScript = readFileSync(resolve('scripts/install'), 'utf8')
const updateScript = readFileSync(resolve('scripts/bin/sp-update'), 'utf8')

const BEGIN = '# BEGIN sleepypod-telemetry-block'
const END = '# END sleepypod-telemetry-block'

/** The managed block earlier releases wrote with 0.0.0.0 entries. */
const OLD_BLOCK = `${BEGIN}\n0.0.0.0 raw-api-upload.8slp.net\n0.0.0.0 device-api-ws.8slp.net\n${END}`
const OLD_CONF = [
  '# Managed by: scripts/internet-control dns-block|dns-unblock', 'listen-address=127.0.0.1', 'bind-interfaces', 'port=53',
  'resolv-file=/run/NetworkManager/no-stub-resolv.conf', 'cache-size=1000',
  'address=/8slp.net/0.0.0.0', 'address=/8slp.net/::', 'address=/kinesis.us-east-1.amazonaws.com/0.0.0.0', 'address=/kinesis.us-east-1.amazonaws.com/::',
].join('\n') + '\n'

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
  unmask) [ "$(cat "$u/$2" 2>/dev/null)" = masked ] && echo disabled > "$u/$2" ;;
  start) : > "$u/$2.active" ;;
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
 * unit is active, and blackholes like the real one from its conf: an
 * address-less address=/8slp.net/ is NXDOMAIN, address=/8slp.net/0.0.0.0 is
 * 0.0.0.0. dnsmasq-answers forces an address for blackholed names. Upstream
 * resolves Eight Sleep names; dns-down breaks upstream lookups.
 */
const HOSTS_LOOKUP = `hosts_lookup() { awk -v n="$1" '!/^[[:space:]]*#/ { for (i = 2; i <= NF; i++) if ($i == n) { print $1; exit } }' "$ROOT/etc/hosts" 2>/dev/null; }`

/** ping NAME resolves like glibc/busybox: /etc/hosts first, then DNS via the system resolver. */
const PING = `
${HOSTS_LOOKUP}
for name; do :; done
addr=$(hosts_lookup "$name")
[ -n "$addr" ] || addr=$(nslookup "$name" | awk '/^Name:/ { f = 1; next } f && /^Address/ { print $2; exit }')
[ -n "$addr" ] || { echo "ping: bad address '$name'" >&2; exit 1; }
echo "PING $name ($addr): 56 data bytes"
exit 1`

const NSLOOKUP = `
${HOSTS_LOOKUP}
printf 'Server:\\t\\t127.0.0.1\\nAddress:\\t127.0.0.1:53\\n\\n'
fail() { echo "** server can't find $1: NXDOMAIN"; exit 1; }
answer() { printf 'Non-authoritative answer:\\nName:\\t%s\\nAddress: %s\\n' "$1" "$2"; exit 0; }
conf="$ROOT/etc/sleepypod/dnsmasq.conf"
via_dnsmasq=false
if [ "\${2:-}" = 127.0.0.1 ]; then via_dnsmasq=true
elif [ -z "\${2:-}" ] && [ "$(readlink "$ROOT/etc/resolv.conf")" = /etc/sleepypod/resolv.conf ]; then via_dnsmasq=true; fi
if [ "$via_dnsmasq" = true ]; then
  [ -f "$ROOT/units/sleepypod-dns.service.active" ] && [ ! -f "$ROOT/dnsmasq-broken" ] || fail "$1"
  # dnsmasq also serves /etc/hosts, ahead of its address= rules.
  hosted=$(hosts_lookup "$1")
  [ -n "$hosted" ] && answer "$1" "$hosted"
fi
case "$1" in
  *8slp.net)
    if [ "$via_dnsmasq" = true ]; then
      [ -f "$ROOT/dnsmasq-answers" ] && answer "$1" "$(cat "$ROOT/dnsmasq-answers")"
      grep -qx 'address=/8slp.net/0.0.0.0' "$conf" && answer "$1" 0.0.0.0
      grep -qx 'address=/8slp.net/' "$conf" && fail "$1"
    fi
    [ -f "$ROOT/dns-down" ] && fail "$1"; answer "$1" 52.0.0.1 ;;
  *) [ -f "$ROOT/dns-down" ] && fail "$1"; answer "$1" 140.82.112.3 ;;
esac`

const env = () => ({ ...process.env, INTERNET_CONTROL_ROOT: root, ROOT: root, PATH: `${bin}:/usr/bin:/bin` })

function run(...args: string[]) {
  return spawnSync('/bin/bash', [controlScript, ...args], { encoding: 'utf8', env: env() })
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
  stub(join(bin, 'ping'), PING)
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

describe('internet-control /etc/hosts layer', () => {
  it('hosts-block refuses and leaves /etc/hosts alone, since 0.0.0.0 sends frank to the pod itself', () => {
    const result = run('hosts-block')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('frank retry storm')
    expect(result.stderr).toContain('dns-block')
    expect(result.stderr).toContain('hosts-unblock')
    expect(hosts()).toBe('127.0.0.1 localhost\n')
    expect(existsSync(`${hostsPath()}.bak.sleepypod`)).toBe(false)
  })

  it('usage no longer offers hosts-block', () => {
    const result = spawnSync('/bin/bash', [controlScript], { encoding: 'utf8', env: env() })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('hosts-unblock')
    expect(result.stdout).not.toMatch(/hosts-block\b/)
  })

  it('hosts-unblock removes an existing managed block and keeps a backup', () => {
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n\n${OLD_BLOCK}\n192.168.1.5 nas\n`)
    const result = run('hosts-unblock')
    expect(result.status, result.stderr).toBe(0)
    expect(hosts()).toBe('127.0.0.1 localhost\n\n192.168.1.5 nas\n')
    expect(readFileSync(`${hostsPath()}.bak.sleepypod`, 'utf8')).toContain('0.0.0.0 raw-api-upload.8slp.net')
  })

  it('hosts-unblock refuses to edit mismatched markers', () => {
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n${BEGIN}\n0.0.0.0 api.8slp.net\n`)
    const result = run('hosts-unblock')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('refusing destructive edit')
    expect(hosts()).toContain('0.0.0.0 api.8slp.net')
  })
})

describe('internet-control dns-block', () => {
  it('runs its own dnsmasq on 127.0.0.1 and repoints resolv.conf only after it answers', () => {
    const result = run('dns-block')
    expect(result.status, result.stderr).toBe(0)
    const conf = readFileSync(sp('dnsmasq.conf'), 'utf8')
    for (const line of ['listen-address=127.0.0.1', 'bind-interfaces', 'port=53', 'resolv-file=/run/NetworkManager/no-stub-resolv.conf', 'cache-size=1000',
      'address=/8slp.net/', 'address=/kinesis.us-east-1.amazonaws.com/']) {
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

  it('answers NXDOMAIN: the conf has no 0.0.0.0 and no :: addresses', () => {
    expect(run('dns-block').status).toBe(0)
    const conf = readFileSync(sp('dnsmasq.conf'), 'utf8')
    expect(conf).not.toContain('0.0.0.0')
    expect(conf).not.toContain('::')
    expect(conf.split('\n').filter(line => line.startsWith('address='))).toEqual(['address=/8slp.net/', 'address=/kinesis.us-east-1.amazonaws.com/'])
  })

  it('rewrites an old 0.0.0.0 conf and restarts the unit', () => {
    expect(run('dns-block').status).toBe(0)
    writeFileSync(sp('dnsmasq.conf'), OLD_CONF)
    const result = run('dns-block')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('already up to date')
    expect(readFileSync(sp('dnsmasq.conf'), 'utf8')).not.toContain('0.0.0.0')
    expect(systemctlLog().match(/restart sleepypod-dns.service/g)).toHaveLength(2)
    expect(resolvTarget()).toBe(OUR_RESOLV)
  })

  it.each(['0.0.0.0', '::', '127.0.0.1', '203.0.113.7'])('fails verification and rolls back when the probe name resolves to %s', (address) => {
    writeFileSync(join(root, 'dnsmasq-answers'), address)
    const result = run('dns-block')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('sleepypod-probe.8slp.net must be NXDOMAIN')
    expect(result.stderr).toContain('Rolling back')
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(existsSync(unitFile()) || existsSync(sp('dnsmasq.conf'))).toBe(false)
  })

  it('removes a leftover managed hosts block first, since /etc/hosts beats NXDOMAIN', () => {
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n\n${OLD_BLOCK}\n`)
    const result = run('dns-block')
    expect(result.status, result.stderr).toBe(0)
    expect(hosts()).toBe('127.0.0.1 localhost\n')
    expect(readFileSync(`${hostsPath()}.bak.sleepypod`, 'utf8')).toContain(BEGIN)
    expect(resolvTarget()).toBe(OUR_RESOLV)
  })

  it('fails and rolls back a working layer when the hosts markers are malformed', () => {
    expect(run('dns-block').status).toBe(0)
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n${BEGIN}\n0.0.0.0 raw-api-upload.8slp.net\n`)
    const result = run('dns-block')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('refusing destructive edit')
    expect(result.stderr).toContain('Rolling back')
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(existsSync(unitFile())).toBe(false)
    expect(hosts()).toContain(BEGIN)
  })

  it('fails verification and rolls back when raw-api-upload.8slp.net still resolves through the system resolver', () => {
    // A hand-written entry outside the managed block survives the removal.
    writeFileSync(hostsPath(), '127.0.0.1 localhost\n0.0.0.0 raw-api-upload.8slp.net\n')
    const result = run('dns-block')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('raw-api-upload.8slp.net must not resolve')
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    expect(existsSync(unitFile())).toBe(false)
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
    expect(result.stdout).toContain('no name blocking')
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

  it('start hook refuses when the probe name gets any address', () => {
    run('dns-block')
    hook('down')
    for (const address of ['0.0.0.0', '203.0.113.7']) {
      writeFileSync(join(root, 'dnsmasq-answers'), address)
      expect(hook('up').status).not.toBe(0)
      expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
    }
  })

  it('start hook puts the original resolver back when frank\'s name still resolves through /etc/hosts', () => {
    run('dns-block')
    hook('down')
    writeFileSync(hostsPath(), '127.0.0.1 localhost\n0.0.0.0 raw-api-upload.8slp.net\n')
    const failed = hook('up')
    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain('raw-api-upload.8slp.net still resolves')
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
  })
})

describe('internet-control status', () => {
  it('names the dnsmasq NXDOMAIN layer and the telemetry service state', () => {
    writeFileSync(join(root, 'units', 'vector.service'), 'masked')
    expect(run('status').stdout).toMatch(/Layer 2 \(names\): +none/)
    run('dns-block')
    const out = run('status').stdout
    expect(out).toMatch(/Layer 2 \(names\): +dnsmasq NXDOMAIN \(8slp\.net kinesis\.us-east-1\.amazonaws\.com/)
    expect(out).toMatch(/vector\.service +masked\n/)
    expect(out).toMatch(/telegraf\.service +not installed\n/)
    expect(out).not.toContain('Warning')
    rmSync(join(root, 'units', 'sleepypod-dns.service.active'))
    const stopped = run('status').stdout
    expect(stopped).toMatch(/Layer 2 \(names\): +none/)
    expect(stopped).toContain('dnsmasq layer:       configured but not in use')
  })

  it('warns about a leftover managed hosts block and says how to remove it', () => {
    run('dns-block')
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n\n${OLD_BLOCK}\n`)
    const out = run('status').stdout
    expect(out).toMatch(/Layer 2 \(names\): +dnsmasq NXDOMAIN/)
    expect(out).toContain('frank retry storm')
    expect(out).toContain('hosts-unblock')
  })
})

describe('stock telemetry services', () => {
  function disableTwice(vectorDir: string) {
    const script = `source ${helpers}; disable_stock_telemetry; echo --- >> "$ROOT/systemctl.log"; disable_stock_telemetry`
    return spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, ROOT: root, SLEEPYPOD_ROOT: root, VECTOR_DATA_DIR: vectorDir, PATH: `${bin}:/usr/bin:/bin` },
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
    expect(systemctlLog()).not.toMatch(/frankenfirmware|dac|capybara|burrow|swupdate-usb/i)
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

describe('stock firmware updater and watchdog', () => {
  const FIRMWARE_UNITS = ['swupdate.socket', 'swupdate.service', 'swupdate-progress.service', 'defibrillator.service']
  const ALL_UNITS = ['vector.service', 'telegraf.service', ...FIRMWARE_UNITS, 'eight-kernel.service']
  const NEVER_TOUCHED = ['swupdate-usb@sda1.service', 'frankenfirmware.service', 'capybara.service', 'dac.service', 'burrow.service']
  const unitState = (unit: string) => readFileSync(join(root, 'units', unit), 'utf8').trim()
  const running = (unit: string) => existsSync(join(root, 'units', `${unit}.active`))
  const choice = () => join(root, 'etc', 'sleepypod', 'firmware-updates')
  const lines = () => systemctlLog().split('\n')

  function addUnit(unit: string, state: string, active = true) {
    writeFileSync(join(root, 'units', unit), state)
    if (active) writeFileSync(join(root, 'units', `${unit}.active`), '')
  }

  function disableStock(script = 'disable_stock_telemetry') {
    return spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', `source ${helpers}; ${script}`], {
      encoding: 'utf8',
      env: { ...process.env, ROOT: root, SLEEPYPOD_ROOT: root, VECTOR_DATA_DIR: join(root, 'none'), PATH: `${bin}:/usr/bin:/bin` },
    })
  }

  it('masks the updater, watchdog and eight-kernel, socket before service, and stops them', () => {
    addUnit('swupdate.socket', 'enabled')
    addUnit('swupdate.service', 'static')
    addUnit('swupdate-progress.service', 'disabled')
    addUnit('defibrillator.service', 'enabled')
    addUnit('eight-kernel.service', 'enabled')
    for (const unit of NEVER_TOUCHED) addUnit(unit, 'enabled')

    const result = disableStock()
    expect(result.status, result.stderr).toBe(0)
    for (const unit of [...FIRMWARE_UNITS, 'eight-kernel.service']) {
      expect(lines()).toContain(`disable --now ${unit}`)
      expect(unitState(unit)).toBe('masked')
      expect(running(unit)).toBe(false)
    }
    const at = (line: string) => lines().indexOf(line)
    expect(at('mask swupdate.socket')).toBeLessThan(at('disable --now swupdate.service'))
    expect(at('mask swupdate.socket')).toBeLessThan(at('mask swupdate.service'))
    for (const unit of NEVER_TOUCHED) {
      expect(systemctlLog()).not.toContain(unit)
      expect(running(unit)).toBe(true)
    }
    expect(systemctlLog()).not.toMatch(/frankenfirmware|capybara|dac\.service|burrow|swupdate-usb/)
  })

  it('is idempotent: a second pass only checks state', () => {
    for (const unit of ALL_UNITS) addUnit(unit, 'enabled')
    expect(disableStock().status).toBe(0)
    writeFileSync(join(root, 'systemctl.log'), '')
    expect(disableStock().status).toBe(0)
    expect(systemctlLog()).not.toMatch(/disable|mask|stop/)
    for (const unit of ALL_UNITS) expect(unitState(unit)).toBe('masked')
  })

  it('skips units the pod does not have', () => {
    addUnit('defibrillator.service', 'enabled')
    writeFileSync(join(root, 'units', 'eight-kernel.service'), 'not-found')
    const result = disableStock()
    expect(result.status, result.stderr).toBe(0)
    expect(systemctlLog()).toContain('mask defibrillator.service')
    expect(systemctlLog()).not.toMatch(/(disable --now|mask|stop) (swupdate|eight-kernel)/)
    expect(existsSync(join(root, 'units', 'swupdate.service'))).toBe(false)
  })

  it('stops units that were masked by hand but still run, without re-masking', () => {
    addUnit('swupdate.socket', 'masked')
    addUnit('swupdate.service', 'masked')
    addUnit('defibrillator.service', 'masked', false)
    expect(disableStock().status).toBe(0)
    expect(lines()).toContain('stop swupdate.socket')
    expect(lines()).toContain('stop swupdate.service')
    expect(lines()).not.toContain('stop defibrillator.service')
    expect(systemctlLog()).not.toMatch(/^(disable|mask) /m)
  })

  it('never fails the caller, even when systemctl mask fails', () => {
    addUnit('swupdate.service', 'enabled')
    stub(join(bin, 'systemctl'), SYSTEMCTL.replace('  mask) echo masked > "$u/$2" ;;', '  mask) exit 1 ;;'))
    const result = disableStock('disable_stock_telemetry; echo after')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('after')
    expect(result.stderr).toContain('could not mask swupdate.service')
  })

  it('leaves the updater and watchdog alone when the owner allowed firmware updates', () => {
    for (const unit of ALL_UNITS) addUnit(unit, 'enabled')
    mkdirSync(join(root, 'etc', 'sleepypod'), { recursive: true })
    writeFileSync(choice(), 'allow\n')
    const result = disableStock()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Stock firmware updates allowed by the owner')
    for (const unit of FIRMWARE_UNITS) {
      expect(systemctlLog()).not.toContain(unit)
      expect(unitState(unit)).toBe('enabled')
      expect(running(unit)).toBe(true)
    }
    for (const unit of ['vector.service', 'telegraf.service', 'eight-kernel.service']) expect(unitState(unit)).toBe('masked')
  })

  it.each(['block\n', 'allowed\n', 'ALLOW\n', 'allow please\n', ' allow\n', ''])('masks the updater when the saved choice is %j', (content) => {
    addUnit('swupdate.service', 'enabled')
    mkdirSync(join(root, 'etc', 'sleepypod'), { recursive: true })
    writeFileSync(choice(), content)
    expect(disableStock().status).toBe(0)
    expect(unitState('swupdate.service')).toBe('masked')
  })

  it('install and sp-update respect the opt-in through block_stock_telemetry_from', () => {
    const blockFrom = installScript.match(/^block_stock_telemetry_from\(\) \{[\s\S]*?\n\}\n/m)?.[0] ?? ''
    expect(blockFrom).not.toBe('')
    expect(updateScript).toContain(blockFrom)
    const blockFromTree = () => spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', `${blockFrom}\nblock_stock_telemetry_from "$1"`, 'bash', resolve('.')], {
      encoding: 'utf8',
      env: { ...env(), SLEEPYPOD_ROOT: root, VECTOR_DATA_DIR: join(root, 'none') },
    })
    for (const unit of ['swupdate.socket', 'swupdate.service', 'eight-kernel.service']) addUnit(unit, 'enabled')
    mkdirSync(join(root, 'etc', 'sleepypod'), { recursive: true })
    writeFileSync(choice(), 'allow\n')
    expect(blockFromTree().status).toBe(0)
    expect(unitState('swupdate.service')).toBe('enabled')
    expect(unitState('eight-kernel.service')).toBe('masked')
    writeFileSync(choice(), 'block\n')
    expect(blockFromTree().status).toBe(0)
    expect(unitState('swupdate.socket')).toBe('masked')
    expect(unitState('swupdate.service')).toBe('masked')
  })

  it('internet-control keeps the same unit lists and order as the helpers', () => {
    const arrays = (source: string) => [...source.matchAll(/^(STOCK_[A-Z_]+_UNITS)=\((.*)\)$/gm)].map(m => `${m[1]}=${m[2]}`)
    expect(arrays(readFileSync(controlScript, 'utf8'))).toEqual(arrays(readFileSync(helpers, 'utf8')))
    expect(arrays(readFileSync(helpers, 'utf8'))).toHaveLength(3)
  })

  describe('internet-control firmware-updates', () => {
    beforeEach(() => {
      for (const unit of ALL_UNITS) addUnit(unit, 'masked', false)
      addUnit('swupdate-usb@sda1.service', 'enabled')
      mkdirSync(join(root, 'etc', 'sleepypod'), { recursive: true })
      writeFileSync(sp('dnsmasq.conf'), 'keep\n')
    })

    it('allow unmasks, enables and starts the updater and watchdog with a prominent warning, and saves the choice', () => {
      const result = run('firmware-updates', 'allow')
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toContain('WARNING: STOCK EIGHT SLEEP FIRMWARE UPDATES ARE NOW ALLOWED')
      expect(result.stderr).toContain('REMOVE ROOT ACCESS and UNINSTALL SLEEPYPOD')
      expect(readFileSync(choice(), 'utf8')).toBe('allow\n')
      for (const unit of FIRMWARE_UNITS) {
        expect(lines()).toContain(`unmask ${unit}`)
        expect(lines()).toContain(`enable ${unit}`)
        expect(unitState(unit)).toBe('enabled')
        expect(running(unit)).toBe(true)
      }
      const at = (line: string) => lines().indexOf(line)
      expect(at('start swupdate.service')).toBeLessThan(at('start swupdate.socket'))
      for (const unit of ['vector.service', 'telegraf.service', 'eight-kernel.service']) expect(unitState(unit)).toBe('masked')
      expect(systemctlLog()).not.toContain('swupdate-usb')
      expect(readFileSync(sp('dnsmasq.conf'), 'utf8')).toBe('keep\n')
    })

    it('block masks them again, socket first, and keeps /etc/sleepypod', () => {
      expect(run('firmware-updates', 'allow').status).toBe(0)
      writeFileSync(join(root, 'systemctl.log'), '')
      const result = run('firmware-updates', 'block')
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(choice(), 'utf8')).toBe('block\n')
      for (const unit of FIRMWARE_UNITS) {
        expect(unitState(unit)).toBe('masked')
        expect(running(unit)).toBe(false)
      }
      expect(lines().indexOf('mask swupdate.socket')).toBeLessThan(lines().indexOf('mask swupdate.service'))
      expect(readFileSync(sp('dnsmasq.conf'), 'utf8')).toBe('keep\n')
      expect(systemctlLog()).not.toContain('swupdate-usb')

      writeFileSync(join(root, 'systemctl.log'), '')
      expect(run('firmware-updates', 'block').status).toBe(0)
      expect(systemctlLog()).not.toMatch(/^(disable|mask|stop) /m)
    })

    it('status prints the choice and each unit, and the helpers follow the round trip', () => {
      expect(run('firmware-updates', 'status').stdout).toContain('Firmware updates: blocked')
      run('firmware-updates', 'allow')
      const out = run('firmware-updates', 'status').stdout
      expect(out).toContain('Firmware updates: allowed')
      expect(out).toMatch(/swupdate\.service +NOT masked \(enabled, running\)/)
      expect(out).toMatch(/eight-kernel\.service +masked\n/)
      expect(disableStock().stdout).toContain('Stock firmware updates allowed by the owner')
      run('firmware-updates', 'block')
      expect(run('firmware-updates', 'status').stdout).toContain('Firmware updates: blocked')
    })

    it('rejects a missing or unknown subcommand, and extra arguments for other commands', () => {
      expect(run('firmware-updates').status).not.toBe(0)
      expect(run('firmware-updates', 'maybe').status).not.toBe(0)
      expect(run('status', 'extra').status).not.toBe(0)
      expect(existsSync(choice())).toBe(false)
    })
  })

  it('internet-control status lists every stock service and the firmware-updates choice', () => {
    addUnit('swupdate.socket', 'masked')
    addUnit('swupdate.service', 'enabled')
    addUnit('defibrillator.service', 'masked', false)
    const out = run('status').stdout
    expect(out).toContain('Stock services (masked by install/sp-update):')
    expect(out).toMatch(/swupdate\.socket +masked, running\n/)
    expect(out).toMatch(/swupdate\.service +NOT masked \(enabled, running\)\n/)
    expect(out).toMatch(/swupdate-progress\.service +not installed\n/)
    expect(out).toMatch(/defibrillator\.service +masked\n/)
    expect(out).toMatch(/eight-kernel\.service +not installed\n/)
    expect(out).toMatch(/Firmware updates: +blocked/)
    mkdirSync(join(root, 'etc', 'sleepypod'), { recursive: true })
    writeFileSync(choice(), 'allow\n')
    expect(run('status').stdout).toMatch(/Firmware updates: +allowed/)
  })
})

describe('old /etc/hosts block removal', () => {
  const blockFrom = installScript.match(/^block_stock_telemetry_from\(\) \{[\s\S]*?\n\}\n/m)?.[0] ?? ''

  /** install's and sp-update's block_stock_telemetry_from against tree $1, as root would run it. */
  function blockFromTree(tree: string) {
    return spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', `${blockFrom}\nblock_stock_telemetry_from "$1"`, 'bash', tree], {
      encoding: 'utf8',
      env: { ...env(), VECTOR_DATA_DIR: join(root, 'none') },
    })
  }

  beforeEach(() => {
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n\n${OLD_BLOCK}\n`)
  })

  it('install and sp-update remove an existing managed block from the new tree, then turn on the NXDOMAIN layer', () => {
    expect(blockFrom).not.toBe('')
    const result = blockFromTree(resolve('.'))
    expect(result.status, result.stderr).toBe(0)
    expect(hosts()).toBe('127.0.0.1 localhost\n')
    expect(readFileSync(`${hostsPath()}.bak.sleepypod`, 'utf8')).toContain(BEGIN)
    expect(resolvTarget()).toBe(OUR_RESOLV)
    expect(result.stdout.indexOf('Removed Eight Sleep domains')).toBeLessThan(result.stdout.indexOf('Starting sleepypod-dns.service'))
  })

  it('a tree without telemetry-helpers also only removes the block', () => {
    const legacy = join(root, 'legacy-tree')
    mkdirSync(join(legacy, 'scripts'), { recursive: true })
    writeFileSync(join(legacy, 'scripts', 'internet-control'), readFileSync(controlScript, 'utf8'))
    expect(blockFromTree(legacy).status).toBe(0)
    expect(hosts()).toBe('127.0.0.1 localhost\n')
  })

  it('warns and continues when the markers are malformed', () => {
    writeFileSync(hostsPath(), `127.0.0.1 localhost\n${BEGIN}\n0.0.0.0 api.8slp.net\n`)
    const result = blockFromTree(resolve('.'))
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('could not remove the old /etc/hosts telemetry block (continuing)')
    expect(result.stderr).toContain('dnsmasq NXDOMAIN block not applied')
    expect(hosts()).toContain(BEGIN)
    expect(resolvTarget()).toBe(ORIGINAL_RESOLV)
  })

  it('iptables block also drops the old hosts block instead of writing one', () => {
    const source = readFileSync(controlScript, 'utf8')
    const block = source.match(/^ {2}block\)\n[\s\S]*?\n {4};;/m)?.[0] ?? ''
    expect(block).toContain('remove_hosts_block || true')
    expect(source).not.toMatch(/^\s*add_hosts_block/m)
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

  it('turn on the NXDOMAIN layer in the early pass right after the hosts removal, and again after every download', () => {
    const helperSource = readFileSync(helpers, 'utf8')
    const early = helperSource.match(/^block_stock_telemetry\(\) \{[\s\S]*?\n\}/m)?.[0] ?? ''
    const hostsOnly = helperSource.match(/^apply_name_blocking\(\) \{[\s\S]*?\n\}/m)?.[0] ?? ''
    expect(early.indexOf('apply_name_blocking')).toBeGreaterThan(0)
    expect(early.indexOf('apply_dns_blackhole')).toBeGreaterThan(early.indexOf('apply_name_blocking'))
    expect(hostsOnly).not.toContain('dns-block')
    expect(hostsOnly).toContain('hosts-unblock')
    for (const source of [helperSource, installScript, updateScript]) expect(source).not.toMatch(/internet-control"? hosts-block/)
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
