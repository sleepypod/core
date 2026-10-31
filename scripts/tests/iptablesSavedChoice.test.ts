// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A block set in Settings is saved by the app (User=sleepypod) in
// $DATA_DIR/internet-access. Before the app starts, the unit runs
// `sp-internet-control restore` as root to re-apply it after a reboot.
const controlScript = resolve('scripts/internet-control')
const installScript = readFileSync(resolve('scripts/install'), 'utf8')
const updateScript = readFileSync(resolve('scripts/bin/sp-update'), 'utf8')

const choiceHelpers = resolve('scripts/lib/internet-choice-helpers')
const DROPIN = 'etc/systemd/system/sleepypod.service.d/iptables-saved-choice.conf'
const COPY = 'usr/local/bin/sp-internet-control'

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
    // Same match as install and the app, so a kernel without xt_state can't
    // stop the boot restore before the DROP.
    expect(rules).toContain('-A SLEEPYPOD-BLOCK -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT')
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

/**
 * Run install_internet_choice_restore against a sandbox root, with chown and
 * systemctl stubbed to log. $1 is the source tree.
 */
function installRestore(tree: string) {
  stub(join(bin, 'chown'), 'echo "chown $*" >> "$ROOT/calls.log"')
  stub(join(bin, 'systemctl'), 'echo "systemctl $*" >> "$ROOT/calls.log"')
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail
source "${choiceHelpers}"
install_internet_choice_restore "${tree}"`], {
    encoding: 'utf8',
    env: { NODE_ENV: process.env.NODE_ENV, PATH: `${bin}:/usr/bin:/bin`, ROOT: root, SLEEPYPOD_ROOT: root },
  })
}
const calls = () => existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n') : []
const restoreCommand = () => readFileSync(join(root, DROPIN), 'utf8').match(/-c '(.*)'$/m)?.[1] ?? 'false'

describe('install_internet_choice_restore', () => {
  let tree: string
  beforeEach(() => {
    tree = join(root, 'app')
    mkdirSync(join(tree, 'scripts'), { recursive: true })
    writeFileSync(join(tree, 'scripts/internet-control'), '#!/bin/bash\necho v1\n')
  })

  it('installs a root-owned copy and the best-effort ExecStartPre drop-in', () => {
    const result = installRestore(tree)
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(root, COPY), 'utf8')).toBe('#!/bin/bash\necho v1\n')
    expect(statSync(join(root, COPY)).mode & 0o7777).toBe(0o755)
    expect(calls()).toContain(`chown root:root ${join(root, COPY)}`)
    expect(readFileSync(join(root, DROPIN), 'utf8')).toBe(
      '[Service]\nExecStartPre=+/bin/sh -c \'PATH=/usr/sbin:/sbin:/usr/bin:/bin /usr/local/bin/sp-internet-control restore; true\'\n',
    )
    expect(calls().filter(line => line === 'systemctl daemon-reload')).toHaveLength(1)
  })

  it('is idempotent: reloads systemd only when the drop-in changes, and refreshes the copy', () => {
    expect(installRestore(tree).status).toBe(0)
    writeFileSync(join(tree, 'scripts/internet-control'), '#!/bin/bash\necho v2\n')
    expect(installRestore(tree).status).toBe(0)
    expect(readFileSync(join(root, COPY), 'utf8')).toContain('v2')
    expect(calls().filter(line => line === 'systemctl daemon-reload')).toHaveLength(1)
    // A tampered drop-in is put back.
    writeFileSync(join(root, DROPIN), '[Service]\nExecStartPre=+/home/dac/sleepypod-core/scripts/internet-control restore\n')
    expect(installRestore(tree).status).toBe(0)
    expect(readFileSync(join(root, DROPIN), 'utf8')).toContain('/usr/local/bin/sp-internet-control restore; true')
    expect(calls().filter(line => line === 'systemctl daemon-reload')).toHaveLength(2)
  })

  it('does nothing for a tree without internet-control', () => {
    rmSync(join(tree, 'scripts/internet-control'))
    expect(installRestore(tree).status).toBe(0)
    expect(existsSync(join(root, DROPIN))).toBe(false)
    expect(calls()).toEqual([])
  })

  it('writes no drop-in when the copy cannot be made root-owned', () => {
    stub(join(bin, 'chown'), 'exit 1')
    const result = spawnSync('/bin/bash', ['-c', `source "${choiceHelpers}"; install_internet_choice_restore "${tree}"`], {
      encoding: 'utf8', env: { NODE_ENV: process.env.NODE_ENV, PATH: `${bin}:/usr/bin:/bin`, ROOT: root, SLEEPYPOD_ROOT: root },
    })
    expect(result.status).not.toBe(0)
    expect(existsSync(join(root, DROPIN))).toBe(false)
  })

  it('runs a root-owned copy with sbin on PATH, never the install tree', () => {
    expect(installRestore(tree).status).toBe(0)
    const command = restoreCommand()
    expect(command).toContain('PATH=/usr/sbin:/sbin:')
    expect(command).not.toContain('$')
    expect(command).not.toContain('/home/dac')
  })

  it.each([
    ['missing', null],
    ['failing', 'exit 1'],
  ])('never fails the service start when sp-internet-control is %s', (_name, body) => {
    expect(installRestore(tree).status).toBe(0)
    const tool = join(bin, 'sp-internet-control')
    if (body) stub(tool, body)
    const command = restoreCommand()
      .replace('PATH=/usr/sbin:/sbin:/usr/bin:/bin', `PATH=${bin}`)
      .replace('/usr/local/bin/sp-internet-control', tool)
    expect(command).toContain(`${tool} restore`)
    expect(spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).status).toBe(0)
  })

  it('sp-update and install use the helper instead of their own copy', () => {
    for (const script of [installScript, updateScript]) {
      expect(script).toContain('source "$INSTALL_DIR/scripts/lib/internet-choice-helpers"')
      expect(script).toMatch(/install_internet_choice_restore "\$INSTALL_DIR" \|\| echo "Warning:/)
      expect(script).not.toContain('sp-internet-control restore')
    }
  })
})
