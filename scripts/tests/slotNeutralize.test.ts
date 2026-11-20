// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const script = resolve('scripts/bin/sp-neutralize-slot-b')
const controlScript = resolve('scripts/internet-control')

const MASKED = ['vector.service', 'telegraf.service', 'dac.service', 'swupdate.socket', 'swupdate.service', 'swupdate-progress.service', 'defibrillator.service', 'eight-kernel.service']
const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa laptop'
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb phone'
const STOCK_SSHD_CONFIG = [
  '#\t$OpenBSD: sshd_config,v 1.104 2021/07/02 05:11:21 dtucker Exp $', '', 'Port 8822', 'ListenAddress 0.0.0.0',
  '#HostKey /etc/ssh/ssh_host_rsa_key', 'PermitRootLogin no', 'AuthorizedKeysFile\t/etc/ssh/authorized_keys .ssh/authorized_keys',
  'PasswordAuthentication no', 'UsePAM yes', 'Banner /etc/issue', 'Subsystem\tsftp\t/usr/libexec/sftp-server', 'AllowUsers rewt', '',
].join('\n') + '\n'

// Each run spawns a dozen bash stubs (sshd -T, ssh-keygen, ...); the full
// scripts suite runs files in parallel, where that exceeds the 5 s default.
vi.setConfig({ testTimeout: 30_000 })

let root: string
let bin: string
let slot: string
let host: string

function stub(path: string, body: string) {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

/** findmnt: -S DEV answers from $ROOT/premounted; -o SOURCE MNT from what the mount stub recorded. */
const FINDMNT = `
case "$*" in
  *" -S "*) [ -f "$ROOT/premounted" ] && echo /mnt/elsewhere; exit 0 ;;
  *"-o SOURCE"*) [ -f "$ROOT/mounted-source" ] && cat "$ROOT/mounted-source"; exit 0 ;;
esac`
const MOUNT = `
echo "mount $*" >> "$ROOT/calls.log"
[ -f "$ROOT/mount-fails" ] && exit 32
if [ -f "$ROOT/mount-mismatch" ]; then echo /dev/other > "$ROOT/mounted-source"; else echo "$3" > "$ROOT/mounted-source"; fi`
const UMOUNT = `echo "umount $*" >> "$ROOT/calls.log"; rm -f "$ROOT/mounted-source"`
const FW_PRINTENV = `
if [ "$1" = -n ]; then awk -F= -v k="$2" '$1 == k { print $2 }' "$ROOT/uboot-env"; exit 0; fi
for k; do awk -F= -v k="$k" '$1 == k { print }' "$ROOT/uboot-env"; done`
/**
 * sshd -t / -T against the config named by -f, like OpenSSH prints it: one
 * lowercase keyword per line, list directives one entry per line. The slot's
 * config is rejected when $ROOT/sshd-rejects exists.
 */
const SSHD = `
cfg=/etc/ssh/sshd_config; mode=""
while [ $# -gt 0 ]; do
  case "$1" in -f) cfg="$2"; shift ;; -t) mode=t ;; -T) mode=T ;; -h|-C) shift ;; esac
  shift
done
case "$cfg" in "$ROOT/host/"*) ;; *) [ -f "$ROOT/sshd-rejects" ] && exit 255 ;; esac
[ "$mode" = t ] && exit 0
awk '
  tolower($1) == "allowusers" { for (i = 2; i <= NF; i++) print "allowusers", $i; next }
  tolower($1) ~ /^(permitrootlogin|authorizedkeysfile|passwordauthentication)$/ && !seen[tolower($1)]++ { k = tolower($1); $1 = ""; sub(/^[ \\t]+/, ""); print k, $0 }
' "$cfg"`
const SSH_KEYGEN = `while [ $# -gt 0 ]; do [ "$1" = -f ] && { : > "$2"; : > "$2.pub"; }; shift; done; exit 0`

function env(extra: Record<string, string> = {}) {
  return {
    ...process.env, ROOT: root, PATH: `${bin}:/usr/bin:/bin`,
    SP_SLOT_CMDLINE: join(root, 'cmdline'), SP_SLOT_DEV_DIR: join(root, 'dev'), SP_SLOT_MOUNT: slot, SP_SLOT_HOST_ROOT: host,
    INTERNET_CONTROL_ROOT: '', ...extra,
  }
}

function run(...args: string[]) {
  return spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: env() })
}

const s = (...parts: string[]) => join(slot, ...parts)
/** The device path as the script resolves it (readlink -f; /var is /private/var on macOS). */
const dev = (label: string) => realpathSync(join(root, 'dev', label))
/** existsSync follows symlinks; the wants links point into a /lib that is not on this machine. */
function linkExists(path: string) {
  try {
    lstatSync(path)
    return true
  }
  catch {
    return false
  }
}
const calls = () => existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n') : []
const isMask = (unit: string) => existsSync(s('etc/systemd/system', unit)) && readlinkSync(s('etc/systemd/system', unit)) === '/dev/null'
const marker = () => readFileSync(s('etc/sleepypod/slot-neutralized'), 'utf8')
const sshdConfig = () => readFileSync(s('etc/ssh/sshd_config'), 'utf8')
const directive = (name: string) => sshdConfig().split('\n').filter(line => line.startsWith(`${name} `))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-slot-'))
  bin = join(root, 'bin')
  slot = join(root, 'mnt')
  host = join(root, 'host')
  for (const dir of [bin, join(root, 'dev'), join(host, 'etc/ssh'), join(host, 'home/root/ssh'), join(host, 'usr/lib'),
    s('etc/ssh'), s('etc/systemd/system/multi-user.target.wants'), s('etc/systemd/system/sockets.target.wants'), s('lib/systemd/system'), s('usr/bin'), s('usr/lib')]) {
    mkdirSync(dir, { recursive: true })
  }
  stub(join(bin, 'findmnt'), FINDMNT)
  stub(join(bin, 'mount'), MOUNT)
  stub(join(bin, 'umount'), UMOUNT)
  stub(join(bin, 'fw_printenv'), FW_PRINTENV)
  stub(join(bin, 'sshd'), SSHD)
  stub(join(bin, 'ssh-keygen'), SSH_KEYGEN)
  stub(join(bin, 'sync'), 'exit 0')

  // The running slot (A): a key enrolled where free-sleep's sshd_config points.
  writeFileSync(join(root, 'cmdline'), 'console=ttyS0 root=PARTLABEL=rootfs_a rootwait\n')
  writeFileSync(join(root, 'uboot-env'), 'current_slot=a\nboot_a_success=1\nretry_boot_a=5\nboot_b_success=1\nretry_boot_b=5\n')
  writeFileSync(join(root, 'dev/rootfs_b'), '')
  writeFileSync(join(root, 'dev/rootfs_a'), '')
  writeFileSync(join(host, 'etc/ssh/sshd_config'), 'Port 8822\nPermitRootLogin yes\nAuthorizedKeysFile /home/root/ssh/authorized_keys\nAllowUsers root rewt\n')
  writeFileSync(join(host, 'home/root/ssh/authorized_keys'), `# laptop and phone\n${KEY_A}\n${KEY_B}\n`)
  writeFileSync(join(host, 'etc/rat_version'), '8df35cc8f9d2f36c3314d8f654193a595339ee9d')
  writeFileSync(join(host, 'usr/lib/os-release'), 'ID=eight\nVERSION_ID=4.0.2\n')

  // The other slot (B): factory 4.0.2.
  writeFileSync(s('etc/ssh/sshd_config'), STOCK_SSHD_CONFIG)
  writeFileSync(s('etc/passwd'), 'root:x:0:0:root:/home/root:/bin/sh\nrewt:x:1001:1001::/home/rewt:/bin/sh\n')
  writeFileSync(s('etc/rat_version'), '8df35cc8f9d2f36c3314d8f654193a595339ee9d')
  writeFileSync(s('usr/lib/os-release'), 'ID=eight\nVERSION_ID=4.0.2\n')
  writeFileSync(s('etc/hosts'), '127.0.0.1\tlocalhost\n127.0.1.1 eight-pod\n')
  symlinkSync('/etc/resolv-conf.NetworkManager', s('etc/resolv.conf'))
  stub(s('usr/bin/dnsmasq'), 'exit 0')
  for (const unit of [...MASKED, 'dnsmasq.service', 'capybara.service', 'frank.service']) {
    writeFileSync(s('lib/systemd/system', unit), `[Unit]\nDescription=${unit}\n`)
  }
  for (const unit of ['swupdate.service', 'defibrillator.service', 'eight-kernel.service', 'vector.service', 'dac.service', 'dnsmasq.service', 'capybara.service', 'frank.service']) {
    symlinkSync(`/lib/systemd/system/${unit}`, s('etc/systemd/system/multi-user.target.wants', unit))
  }
  symlinkSync('/lib/systemd/system/swupdate.socket', s('etc/systemd/system/sockets.target.wants/swupdate.socket'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('sp-neutralize-slot-b apply', () => {
  it('mounts the other slot read-write, neutralizes it, and unmounts', () => {
    const result = run()
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(calls()).toEqual([`mount -o rw ${dev('rootfs_b')} ${slot}`, `umount ${slot}`])
    expect(existsSync(join(root, 'mounted-source'))).toBe(false)

    // SSH: both keys into the file the stock sshd reads, shared with rewt so left world-readable.
    const keys = readFileSync(s('etc/ssh/authorized_keys'), 'utf8')
    expect(keys).toBe(`${KEY_A}\n${KEY_B}\n`)
    expect(statSync(s('etc/ssh/authorized_keys')).mode & 0o777).toBe(0o644)
    expect(directive('PermitRootLogin')).toEqual(['PermitRootLogin prohibit-password'])
    expect(directive('AllowUsers')).toEqual(['AllowUsers rewt root'])
    expect(directive('PasswordAuthentication')).toEqual(['PasswordAuthentication no'])
    expect(readFileSync(s('etc/ssh/sshd_config.pre-neutralize'), 'utf8')).toBe(STOCK_SSHD_CONFIG)
    expect(existsSync(s('etc/ssh/sshd_config_readonly'))).toBe(false)

    // The same eight masks the running slot carries; frank and Capybara are never touched.
    for (const unit of MASKED) expect(isMask(unit), unit).toBe(true)
    expect(isMask('capybara.service')).toBe(false)
    expect(isMask('frank.service')).toBe(false)
    expect(linkExists(s('etc/systemd/system/multi-user.target.wants/swupdate.service'))).toBe(true)

    // Name blocking: the dnsmasq layer written offline and enabled; resolv.conf untouched until its hook runs.
    expect(readFileSync(s('etc/sleepypod/dnsmasq.conf'), 'utf8')).toContain('address=/8slp.net/\n')
    expect(readFileSync(s('etc/systemd/system/sleepypod-dns.service'), 'utf8')).toContain('ExecStart=/usr/bin/dnsmasq -k --conf-file=/etc/sleepypod/dnsmasq.conf\n')
    expect(readlinkSync(s('etc/systemd/system/multi-user.target.wants/sleepypod-dns.service'))).toBe('/etc/systemd/system/sleepypod-dns.service')
    expect(readFileSync(s('etc/sleepypod/resolv.conf.orig-target'), 'utf8')).toBe('/etc/resolv-conf.NetworkManager\n')
    expect(readlinkSync(s('etc/resolv.conf'))).toBe('/etc/resolv-conf.NetworkManager')
    expect(linkExists(s('etc/systemd/system/multi-user.target.wants/dnsmasq.service'))).toBe(false)
    expect(readFileSync(s('etc/hosts'), 'utf8')).not.toContain('0.0.0.0')

    // Marker and saved choice.
    expect(marker()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n/)
    expect(marker()).toContain('from_slot=rootfs_a (4.0.2 8df35cc8)\n')
    expect(marker()).toContain('target_build=4.0.2 8df35cc8\n')
    expect(marker()).toContain('authorized_keys_created=yes\n')
    expect(marker()).toContain('stock_dnsmasq_enabled=yes\n')
    expect(marker()).toContain('dns_installed=yes\n')
    expect(readFileSync(s('etc/sleepypod/firmware-updates'), 'utf8')).toBe('block\n')
    expect(readFileSync(join(host, 'etc/sleepypod/other-slot-neutralized'), 'utf8')).toBe(marker())
    expect(result.stdout).toContain('rootfs_b neutralized')
    expect(result.stdout).toContain('current_slot=a')
  })

  it('is idempotent: a second run adds no keys, keeps the stock backup, and reports the earlier run', () => {
    expect(run().status).toBe(0)
    const first = marker()
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Already neutralized on')
    expect(readFileSync(s('etc/ssh/authorized_keys'), 'utf8')).toBe(`${KEY_A}\n${KEY_B}\n`)
    expect(directive('AllowUsers')).toEqual(['AllowUsers rewt root'])
    expect(readFileSync(s('etc/ssh/sshd_config.pre-neutralize'), 'utf8')).toBe(STOCK_SSHD_CONFIG)
    expect(existsSync(s('etc/ssh/authorized_keys.pre-neutralize'))).toBe(false)
    expect(marker()).toContain('stock_dnsmasq_enabled=yes\n')
    expect(marker().split('\n').slice(1)).toEqual(first.split('\n').slice(1))
  })

  it('appends to an existing shared authorized_keys and keeps a backup of it', () => {
    writeFileSync(s('etc/ssh/authorized_keys'), `${KEY_B}\n`)
    expect(run().status).toBe(0)
    expect(readFileSync(s('etc/ssh/authorized_keys'), 'utf8')).toBe(`${KEY_B}\n${KEY_A}\n`)
    expect(readFileSync(s('etc/ssh/authorized_keys.pre-neutralize'), 'utf8')).toBe(`${KEY_B}\n`)
    expect(marker()).toContain('authorized_keys_created=no\n')
  })

  it('writes the key where the other slot resolves %h, with private modes under a home', () => {
    writeFileSync(s('etc/ssh/sshd_config'), STOCK_SSHD_CONFIG.replace(/AuthorizedKeysFile.*/, 'AuthorizedKeysFile %h/.ssh/authorized_keys'))
    expect(run().status).toBe(0)
    expect(readFileSync(s('home/root/.ssh/authorized_keys'), 'utf8')).toBe(`${KEY_A}\n${KEY_B}\n`)
    expect(statSync(s('home/root/.ssh/authorized_keys')).mode & 0o777).toBe(0o600)
    expect(statSync(s('home/root/.ssh')).mode & 0o777).toBe(0o700)
  })

  it('targets rootfs_a when the pod runs from rootfs_b', () => {
    writeFileSync(join(root, 'cmdline'), 'root=PARTLABEL=rootfs_b rootwait\n')
    writeFileSync(join(root, 'uboot-env'), 'current_slot=b\nboot_b_success=1\nretry_boot_b=5\n')
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(calls()[0]).toBe(`mount -o rw ${dev('rootfs_a')} ${slot}`)
    expect(result.stdout).toContain('rootfs_a neutralized')
  })

  it('warns, and the marker and brief status say so, when the other slot has no dnsmasq to block names with', () => {
    rmSync(s('usr/bin/dnsmasq'))
    const result = run()
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(result.stderr).toContain('Warning: no name blocking was installed in rootfs_b')
    expect(result.stdout).toContain('rootfs_b neutralized')
    expect(result.stdout).toContain('but no name blocking')
    expect(result.stdout).not.toContain('NXDOMAIN')
    expect(marker()).toContain('dns_installed=no\n')
    expect(existsSync(s('etc/systemd/system/sleepypod-dns.service'))).toBe(false)
    for (const unit of MASKED) expect(isMask(unit), unit).toBe(true)
    expect(run('status', '--brief').stdout.trim()).toMatch(/^other slot \(rootfs_b\): neutralized 20\d\d-.* without name blocking/)
  })

  it('makes one throwaway host key per run and removes it', () => {
    const tmp = join(root, 'tmp')
    mkdirSync(tmp)
    stub(join(bin, 'ssh-keygen'), `echo "ssh-keygen" >> "$ROOT/calls.log"\n${SSH_KEYGEN}`)
    for (const args of [[], ['status'], ['undo']]) {
      const result = spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: env({ TMPDIR: tmp }) })
      expect(result.status, args.join(' ') + result.stderr).toBe(0)
      expect(calls().filter(line => line === 'ssh-keygen'), args.join(' ')).toHaveLength(1)
      expect(readdirSync(tmp), args.join(' ')).toEqual([])
      rmSync(join(root, 'calls.log'))
    }
  })

  it('never writes the U-Boot environment', () => {
    stub(join(bin, 'fw_setenv'), 'echo "fw_setenv $*" >> "$ROOT/calls.log"; exit 1')
    expect(run().status).toBe(0)
    expect(calls().some(call => call.startsWith('fw_setenv'))).toBe(false)
  })
})

describe('sp-neutralize-slot-b refuses when', () => {
  it('the pod does not boot from rootfs_a/b', () => {
    writeFileSync(join(root, 'cmdline'), 'root=/dev/mmcblk1p2 rootwait\n')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not boot from rootfs_a/rootfs_b')
    expect(calls()).toEqual([])
  })

  it('U-Boot is about to switch slots (current_slot differs from the running slot)', () => {
    writeFileSync(join(root, 'uboot-env'), 'current_slot=b\nboot_a_success=0\nretry_boot_a=0\n')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('current_slot=b')
    expect(calls()).toEqual([])
    expect(sshdConfig()).toBe(STOCK_SSHD_CONFIG)
  })

  it('the other slot is already mounted', () => {
    writeFileSync(join(root, 'premounted'), '')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already mounted at /mnt/elsewhere')
    expect(calls()).toEqual([])
  })

  it('the mount lands on a different device', () => {
    writeFileSync(join(root, 'mount-mismatch'), '')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('mount mismatch')
    expect(calls()).toEqual([`mount -o rw ${dev('rootfs_b')} ${slot}`, `umount ${slot}`])
    expect(sshdConfig()).toBe(STOCK_SSHD_CONFIG)
  })

  it('no key is enrolled for root on the running slot', () => {
    writeFileSync(join(host, 'home/root/ssh/authorized_keys'), '')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no SSH key enrolled for root')
    expect(sshdConfig()).toBe(STOCK_SSHD_CONFIG)
    expect(isMask('swupdate.service')).toBe(false)
    expect(calls()).toContain(`umount ${slot}`)
  })

  it('sshd rejects the edited config: the stock file comes back and nothing else is written', () => {
    writeFileSync(join(root, 'sshd-rejects'), '')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not pass sshd -t')
    expect(sshdConfig()).toBe(STOCK_SSHD_CONFIG)
    expect(isMask('swupdate.service')).toBe(false)
    expect(existsSync(s('etc/sleepypod'))).toBe(false)
    expect(calls()).toContain(`umount ${slot}`)
  })
})

describe('sp-neutralize-slot-b status', () => {
  it('reports a stock slot read-only, and the brief line sp-status prints', () => {
    const result = run('status')
    expect(result.status, result.stderr).toBe(0)
    expect(calls()).toEqual([`mount -o ro ${dev('rootfs_b')} ${slot}`, `umount ${slot}`])
    expect(result.stdout).toContain('Marker:   none (stock slot)')
    expect(result.stdout).toContain('Masked:   0/8')
    expect(result.stdout).toContain('stock dnsmasq.service enabled')
    expect(result.stdout).toContain('PermitRootLogin no; AllowUsers rewt')
    expect(run('status', '--brief').stdout.trim()).toBe('other slot (rootfs_b): stock (updater on; sudo sp-neutralize-slot-b to neutralize)')
    expect(sshdConfig()).toBe(STOCK_SSHD_CONFIG)
  })

  it('reports a neutralized slot', () => {
    expect(run().status).toBe(0)
    const result = run('status')
    expect(result.stdout).toContain('Marker:   neutralized 20')
    expect(result.stdout).toContain('Masked:   8/8')
    expect(result.stdout).toContain('sleepypod-dns.service installed and enabled')
    expect(result.stdout).toContain('PermitRootLogin prohibit-password; AllowUsers rewt root; PasswordAuthentication no')
    expect(result.stdout).toContain('2 key(s) in /etc/ssh/authorized_keys')
    expect(run('status', '--brief').stdout.trim()).toMatch(/^other slot \(rootfs_b\): neutralized 20\d\d-/)
  })

  it('calls a half-applied slot out', () => {
    expect(run().status).toBe(0)
    rmSync(s('etc/systemd/system/defibrillator.service'))
    expect(run('status', '--brief').stdout).toContain('partly neutralized (7/8 units masked)')
  })
})

describe('sp-neutralize-slot-b undo', () => {
  it('puts the stock slot back', () => {
    expect(run().status).toBe(0)
    const result = run('undo')
    expect(result.status, result.stderr).toBe(0)
    expect(sshdConfig()).toBe(STOCK_SSHD_CONFIG)
    expect(existsSync(s('etc/ssh/authorized_keys'))).toBe(false)
    expect(existsSync(s('etc/ssh/sshd_config.pre-neutralize'))).toBe(false)
    for (const unit of MASKED) expect(existsSync(s('etc/systemd/system', unit)), unit).toBe(false)
    expect(existsSync(s('etc/systemd/system/sleepypod-dns.service'))).toBe(false)
    expect(existsSync(s('etc/systemd/system/multi-user.target.wants/sleepypod-dns.service'))).toBe(false)
    expect(existsSync(s('etc/sleepypod'))).toBe(false)
    expect(existsSync(join(host, 'etc/sleepypod/other-slot-neutralized'))).toBe(false)
    expect(readlinkSync(s('etc/systemd/system/multi-user.target.wants/dnsmasq.service'))).toBe('/lib/systemd/system/dnsmasq.service')
    expect(readlinkSync(s('etc/resolv.conf'))).toBe('/etc/resolv-conf.NetworkManager')
    expect(calls().at(-1)).toBe(`umount ${slot}`)
    expect(run('status', '--brief').stdout).toContain('stock (updater on')
  })

  it('restores a pre-existing shared authorized_keys instead of deleting it', () => {
    writeFileSync(s('etc/ssh/authorized_keys'), `${KEY_B}\n`)
    expect(run().status).toBe(0)
    expect(run('undo').status).toBe(0)
    expect(readFileSync(s('etc/ssh/authorized_keys'), 'utf8')).toBe(`${KEY_B}\n`)
  })
})

describe('internet-control dns-install (offline)', () => {
  const control = (...args: string[]) => spawnSync('/bin/bash', [controlScript, ...args], { encoding: 'utf8', env: { ...env(), INTERNET_CONTROL_ROOT: slot } })

  it('refuses without a mounted root, so it can never run against the live system', () => {
    // Without a root it is the live-system path, which also wants root; either refusal is fine.
    const result = spawnSync('/bin/bash', [controlScript, 'dns-install'], { encoding: 'utf8', env: { ...env(), INTERNET_CONTROL_ROOT: '' } })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/INTERNET_CONTROL_ROOT|must be run as root/)
    const bad = spawnSync('/bin/bash', [controlScript, 'dns-install'], { encoding: 'utf8', env: { ...env(), INTERNET_CONTROL_ROOT: '/' } })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('not a mounted root filesystem')
    const noEtc = spawnSync('/bin/bash', [controlScript, 'dns-install'], { encoding: 'utf8', env: { ...env(), INTERNET_CONTROL_ROOT: join(root, 'dev') } })
    expect(noEtc.status).toBe(1)
    expect(existsSync(s('etc/systemd/system/sleepypod-dns.service'))).toBe(false)
  })

  it('writes the dns-block files, enables the unit by symlink and starts nothing', () => {
    stub(join(bin, 'systemctl'), 'echo "systemctl $*" >> "$ROOT/calls.log"')
    const result = control('dns-install')
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(s('etc/sleepypod/dnsmasq.conf'), 'utf8').split('\n').filter(line => line.startsWith('address='))).toEqual(['address=/8slp.net/', 'address=/kinesis.us-east-1.amazonaws.com/'])
    expect(readFileSync(s('etc/sleepypod/resolv.conf'), 'utf8')).toBe('nameserver 127.0.0.1\n')
    expect(lstatSync(s('etc/sleepypod/dns-resolv-hook')).mode & 0o111).toBeTruthy()
    expect(readlinkSync(s('etc/systemd/system/multi-user.target.wants/sleepypod-dns.service'))).toBe('/etc/systemd/system/sleepypod-dns.service')
    expect(readlinkSync(s('etc/resolv.conf'))).toBe('/etc/resolv-conf.NetworkManager')
    expect(calls().some(call => call.startsWith('systemctl'))).toBe(false)
    expect(result.stdout).toContain('Disabling the stock dnsmasq.service')
    expect(linkExists(s('etc/systemd/system/multi-user.target.wants/dnsmasq.service'))).toBe(false)
    expect(control('dns-install').status).toBe(0)
  })

  it('removes a leftover 0.0.0.0 hosts block first', () => {
    writeFileSync(s('etc/hosts'), '127.0.0.1 localhost\n\n# BEGIN sleepypod-telemetry-block\n0.0.0.0 raw-api-upload.8slp.net\n# END sleepypod-telemetry-block\n')
    expect(control('dns-install').status).toBe(0)
    expect(readFileSync(s('etc/hosts'), 'utf8')).toBe('127.0.0.1 localhost\n')
  })

  it('does nothing where the other slot has no dnsmasq', () => {
    rmSync(s('usr/bin/dnsmasq'))
    const result = control('dns-install')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dnsmasq not found')
    expect(existsSync(s('etc/systemd/system/sleepypod-dns.service'))).toBe(false)
    expect(linkExists(s('etc/systemd/system/multi-user.target.wants/dnsmasq.service'))).toBe(true)
  })

  it('dns-uninstall removes what dns-install wrote', () => {
    expect(control('dns-install').status).toBe(0)
    const result = control('dns-uninstall')
    expect(result.status, result.stderr).toBe(0)
    for (const file of ['etc/sleepypod/dnsmasq.conf', 'etc/sleepypod/dns-resolv-hook', 'etc/sleepypod/resolv.conf', 'etc/sleepypod/resolv.conf.orig-target',
      'etc/systemd/system/sleepypod-dns.service', 'etc/systemd/system/multi-user.target.wants/sleepypod-dns.service']) {
      expect(existsSync(s(file)), file).toBe(false)
    }
    expect(control('dns-uninstall').stdout).toContain('No dnsmasq wildcard block found')
  })
})
