// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A block set in Settings is saved by the app (User=sleepypod) in
// $DATA_DIR/internet-access. Before the app starts, the unit runs
// `sp-internet-control restore` as root to re-apply it after a reboot.
const controlScript = resolve('scripts/internet-control')
const installScript = readFileSync(resolve('scripts/install'), 'utf8')
const updateScript = readFileSync(resolve('scripts/bin/sp-update'), 'utf8')

const RESTORE_LINE = /^ExecStartPre=\+\/bin\/sh -c '[^']*\/usr\/local\/bin\/sp-internet-control restore; true'$/m

let root: string
let bin: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-saved-choice-'))
  bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, 'chains'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function stub(path: string, body: string) {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

/**
 * iptables backed by $ROOT/chains/<chain> (rules as `-S` prints them) and
 * <chain>.policy. Logs each call, and the XTABLES_LOCKFILE it saw.
 */
const IPTABLES = `
c="$ROOT/chains"
echo "$* lock=\${XTABLES_LOCKFILE:-default}" >> "$ROOT/iptables.log"
policy() { cat "$c/$1.policy" 2>/dev/null || echo ACCEPT; }
case "$1" in
  -S)
    case "$2" in
      INPUT|OUTPUT|FORWARD) echo "-P $2 $(policy "$2")" ;;
      *) [ -f "$c/$2" ] || exit 1; echo "-N $2" ;;
    esac
    cat "$c/$2" 2>/dev/null; exit 0 ;;
  -N) [ -f "$c/$2" ] && exit 1; : > "$c/$2" ;;
  -F) : > "$c/$2" ;;
  -D) shift; chain="$1"; shift; line="-A $chain $*"; [ -f "$c/$chain" ] && grep -qxF -- "$line" "$c/$chain" || exit 1
      grep -vxF -- "$line" "$c/$chain" > "$c/tmp" || true; mv "$c/tmp" "$c/$chain" ;;
  -I) shift; chain="$1"; shift; { echo "-A $chain $*"; cat "$c/$chain" 2>/dev/null; } > "$c/tmp"; mv "$c/tmp" "$c/$chain" ;;
  -A) shift; chain="$1"; shift; echo "-A $chain $*" >> "$c/$chain" ;;
  -P) echo "$3" > "$c/$2.policy" ;;
esac`

function restore(options: { choice?: string, symlink?: boolean, dataDir?: string, output?: string, policy?: string } = {}) {
  stub(join(bin, 'iptables'), IPTABLES)
  const dataDir = options.dataDir ?? '/persistent/sleepypod-data'
  if (options.dataDir) {
    mkdirSync(join(root, 'etc/sleepypod'), { recursive: true })
    writeFileSync(join(root, 'etc/sleepypod/data-dir'), `${options.dataDir}\n`)
  }
  mkdirSync(join(root, dataDir), { recursive: true })
  const file = join(root, dataDir, 'internet-access')
  if (options.choice !== undefined) {
    if (options.symlink) {
      writeFileSync(join(root, 'elsewhere'), options.choice)
      symlinkSync(join(root, 'elsewhere'), file)
    }
    else {
      writeFileSync(file, options.choice)
    }
  }
  if (options.output) writeFileSync(join(root, 'chains/OUTPUT'), options.output)
  if (options.policy) writeFileSync(join(root, 'chains/OUTPUT.policy'), options.policy)
  const result = spawnSync('/bin/bash', [controlScript, 'restore'], {
    encoding: 'utf8',
    env: { NODE_ENV: process.env.NODE_ENV, PATH: `${bin}:/usr/bin:/bin`, INTERNET_CONTROL_ROOT: root, ROOT: root, XTABLES_LOCKFILE: '/run/dac/xtables.lock' },
  })
  const log = existsSync(join(root, 'iptables.log')) ? readFileSync(join(root, 'iptables.log'), 'utf8') : ''
  const chain = (name: string) => existsSync(join(root, 'chains', name)) ? readFileSync(join(root, 'chains', name), 'utf8') : ''
  return { result, log, mutations: log.split('\n').filter(line => line && !line.startsWith('-S ')), chain }
}

describe('internet-control restore', () => {
  it('re-applies a saved block on an open firewall', () => {
    const { result, chain } = restore({ choice: 'blocked\n' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('re-applied the block')
    expect(chain('OUTPUT')).toBe('-A OUTPUT -j SLEEPYPOD-BLOCK\n')
    const rules = chain('SLEEPYPOD-BLOCK').trim().split('\n')
    for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
      expect(rules).toContain(`-A SLEEPYPOD-BLOCK -d ${cidr} -j ACCEPT`)
    }
    // The firewall check's required allows sit in front of the final DROP.
    expect(rules).toContain('-A SLEEPYPOD-BLOCK -p udp --dport 123 -j ACCEPT')
    expect(rules).toContain('-A SLEEPYPOD-BLOCK -d 224.0.0.251/32 -p udp --dport 5353 -j ACCEPT')
    expect(rules.at(-1)).toBe('-A SLEEPYPOD-BLOCK -j DROP')
  })

  it('reads the data dir from /etc/sleepypod/data-dir', () => {
    const { result, chain } = restore({ choice: 'blocked\n', dataDir: '/sleepypod-data' })
    expect(result.status, result.stderr).toBe(0)
    expect(chain('SLEEPYPOD-BLOCK')).toContain('-j DROP')
  })

  it('uses the default xtables lock, never the service user\'s', () => {
    const { log } = restore({ choice: 'blocked\n' })
    expect(log).not.toBe('')
    expect(log).not.toContain('/run/dac/xtables.lock')
  })

  it.each([
    ['a DROP policy', { policy: 'DROP' }],
    ['a terminal DROP', { output: '-A OUTPUT -d 10.0.0.0/8 -j ACCEPT\n-A OUTPUT -j DROP\n' }],
  ])('leaves a firewall that already blocks with %s alone', (_name, state) => {
    const { result, mutations } = restore({ choice: 'blocked\n', ...state })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('already blocks')
    expect(mutations).toEqual([])
  })

  it('blocks when an unconditional ACCEPT comes first', () => {
    const { result, chain } = restore({ choice: 'blocked\n', output: '-A OUTPUT -j ACCEPT\n-A OUTPUT -j DROP\n' })
    expect(result.status, result.stderr).toBe(0)
    expect(chain('OUTPUT').split('\n')[0]).toBe('-A OUTPUT -j SLEEPYPOD-BLOCK')
  })

  it.each([
    ['allowed', { choice: 'allowed\n' }],
    ['missing', {}],
    ['unrecognised', { choice: 'BLOCKED\n' }],
    ['a symlink', { choice: 'blocked\n', symlink: true }],
  ])('never touches iptables when the saved choice is %s', (_name, options) => {
    const { result, log } = restore({ ...options, output: '-A OUTPUT -d 203.0.113.7/32 -j DROP\n' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('firewall left as is')
    expect(log).toBe('')
  })

  it('never prints the saved file\'s contents', () => {
    const { result } = restore({ choice: '$(reboot)\n' })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('reboot')
  })
})

function dropInBlock(): string {
  const match = updateScript.match(/IPTABLES_CHOICE_DROPIN=[\s\S]*?\nfi\n/)
  if (!match) throw new Error('Could not find the saved-choice drop-in in sp-update')
  return match[0]
}

describe('saved internet access drop-in', () => {
  it('fresh installs and OTA updates run the same root-owned restore, best-effort', () => {
    const fromInstall = installScript.match(RESTORE_LINE)?.[0]
    const fromUpdate = updateScript.match(RESTORE_LINE)?.[0]
    expect(fromInstall).toBeDefined()
    expect(fromUpdate).toBe(fromInstall)
    // The unit's Environment PATH has no sbin; iptables lives there.
    expect(fromInstall).toContain('PATH=/usr/sbin:/sbin:')
    expect(fromInstall).not.toContain('$')
    expect(fromInstall).not.toContain('/home/dac')
  })

  it('both install the script as a root-owned copy in /usr/local/bin', () => {
    expect(updateScript).toContain('install -m 0755 "$INSTALL_DIR/scripts/internet-control" /usr/local/bin/sp-internet-control')
    expect(installScript).toContain('cp "$INSTALL_DIR/scripts/internet-control" /usr/local/bin/sp-internet-control')
    expect(installScript).toContain('chown root:root /usr/local/bin/sp-internet-control')
    expect(installScript).toContain('chmod 0755 /usr/local/bin/sp-internet-control')
  })

  it('sp-update writes the drop-in once and reloads systemd only when it changes', () => {
    const dropIn = join(root, 'sleepypod.service.d', 'iptables-saved-choice.conf')
    const reloads = join(root, 'reloads')
    writeFileSync(reloads, '')
    const block = dropInBlock().replace(/^IPTABLES_CHOICE_DROPIN=.*$/m, `IPTABLES_CHOICE_DROPIN=${dropIn}`)
    const script = `systemctl() { echo "$*" >> ${reloads}; }\n${block}${block}`
    const result = spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', script], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(dropIn, 'utf8')).toMatch(/^\[Service\]\nExecStartPre=\+.*sp-internet-control restore; true'\n$/)
    expect(readFileSync(reloads, 'utf8')).toBe('daemon-reload\n')
  })

  it.each([
    ['missing', null],
    ['failing', 'exit 1'],
  ])('never fails the service start when sp-internet-control is %s', (_name, body) => {
    const line = installScript.match(RESTORE_LINE)?.[0] ?? ''
    const tool = join(bin, 'sp-internet-control')
    if (body) stub(tool, body)
    const command = (line.match(/-c '(.*)'$/)?.[1] ?? 'false')
      .replace('PATH=/usr/sbin:/sbin:/usr/bin:/bin', `PATH=${bin}`)
      .replace('/usr/local/bin/sp-internet-control', tool)
    expect(command).toContain(`${tool} restore`)
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    expect(result.status).toBe(0)
  })
})
