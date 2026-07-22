// @vitest-environment node

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const helperSourcePath = resolve('scripts/bin/sp-internet-control')
const updateSourcePath = resolve('scripts/bin/sp-update')
const uninstallSourcePath = resolve('scripts/bin/sp-uninstall')
const maintenanceSourcePath = resolve('scripts/bin/sp-maintenance')
const installSourcePath = resolve('scripts/install')
const privacyHelpersSourcePath = resolve('scripts/bin/sp-network-privacy')
const firewallRestoreSourcePath = resolve('scripts/bin/sp-firewall-restore')
const updateCardSourcePath = resolve('src/components/status/UpdateCard.tsx')

let root: string
let binDir: string
let rulesDir: string
let ipv6SysctlRoot: string
let callsFile: string
let helperPath: string

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n'), { mode: 0o755 })
}

function replaceExact(source: string, from: string, to: string): string {
  expect(source).toContain(from)
  return source.replace(from, to)
}

function shellDoubleQuoted(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')
}

function buildHelper(options: { ipv6?: boolean, failRestoreFile?: boolean } = {}): void {
  const pathPrefix = shellDoubleQuoted(binDir)
  let source = readFileSync(helperSourcePath, 'utf8')
  source = replaceExact(
    source,
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    `export PATH="${pathPrefix}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
  )
  source = replaceExact(source, 'RULES_DIR="/etc/iptables"', `RULES_DIR="${shellDoubleQuoted(rulesDir)}"`)
  source = replaceExact(
    source,
    'LOCK_FILE="/run/lock/sleepypod-internet-control.lock"',
    `LOCK_FILE="${shellDoubleQuoted(join(root, 'firewall.lock'))}"`,
  )
  source = replaceExact(source, 'if [ "$EUID" -ne 0 ]; then', 'if false; then')

  if (options.ipv6 === false) {
    source = replaceExact(source, 'IP6TABLES="$(command -v ip6tables 2>/dev/null || true)"', 'IP6TABLES=""')
    source = replaceExact(source, 'IP6TABLES_SAVE="$(command -v ip6tables-save 2>/dev/null || true)"', 'IP6TABLES_SAVE=""')
    source = replaceExact(source, 'IP6TABLES_RESTORE="$(command -v ip6tables-restore 2>/dev/null || true)"', 'IP6TABLES_RESTORE=""')
  }
  if (options.failRestoreFile === true) {
    source = replaceExact(
      source,
      '    if ! cp -p "$WORK_DIR/$key" "$staged" 2>/dev/null \\',
      '    if true \\',
    )
  }

  writeFileSync(helperPath, source, { mode: 0o755 })
}

function writeCommandStubs(): void {
  writeExecutable(join(binDir, 'iptables'), [
    '#!/bin/bash',
    'printf "iptables %s\\n" "$*" >> "$CALLS_FILE"',
    'if [ "${FAIL_IPTABLES_ARGS:-}" = "$*" ]; then exit 1; fi',
    'case "${1:-}" in -P|-F|-X|-A|-I|-D) rm -f "$STATE_DIR/iptables-restored.rules" ;; esac',
  ])
  writeExecutable(join(binDir, 'ip6tables'), [
    '#!/bin/bash',
    'printf "ip6tables %s\\n" "$*" >> "$CALLS_FILE"',
    'if [ "${FAIL_IP6TABLES_ARGS:-}" = "$*" ]; then exit 1; fi',
    'case "${1:-}" in -P|-F|-X|-A|-I|-D) rm -f "$STATE_DIR/ip6tables-restored.rules" ;; esac',
  ])

  for (const family of ['iptables', 'ip6tables']) {
    writeExecutable(join(binDir, `${family}-save`), [
      '#!/bin/bash',
      `COUNT_FILE="$STATE_DIR/${family}-save.count"`,
      'count=0',
      '[ ! -f "$COUNT_FILE" ] || count="$(cat "$COUNT_FILE")"',
      'count=$((count + 1))',
      'printf "%s" "$count" > "$COUNT_FILE"',
      `printf "${family}-save %s\\n" "$count" >> "$CALLS_FILE"`,
      `fail_var="\${FAIL_${family === 'iptables' ? 'V4' : 'V6'}_SAVE_AT:-0}"`,
      '[ "$fail_var" -ne "$count" ] || exit 1',
      `[ ! -f "$STATE_DIR/${family}-restored.rules" ] || { cat "$STATE_DIR/${family}-restored.rules"; exit 0; }`,
      `printf '*filter\\n# ${family}-save-%s\\nCOMMIT\\n' "$count"`,
    ])
    writeExecutable(join(binDir, `${family}-restore`), [
      '#!/bin/bash',
      'payload="$(cat)"',
      `printf "${family}-restore %s :: %s\\n" "$*" "$payload" >> "$CALLS_FILE"`,
      'if [ "${1:-}" = "--test" ]; then',
      `  COUNT_FILE="$STATE_DIR/${family}-restore-test.count"`,
      '  count=0',
      '  [ ! -f "$COUNT_FILE" ] || count="$(cat "$COUNT_FILE")"',
      '  count=$((count + 1))',
      '  printf "%s" "$count" > "$COUNT_FILE"',
      `  fail_at="\${FAIL_${family === 'iptables' ? 'V4' : 'V6'}_RESTORE_TEST_AT:-0}"`,
      '  [ "$fail_at" -ne "$count" ] || exit 1',
      'else',
      `  [ "\${FAIL_${family === 'iptables' ? 'V4' : 'V6'}_RESTORE_APPLY:-0}" != "1" ] || exit 1`,
      `  printf '%s' "$payload" > "$STATE_DIR/${family}-restored.rules"`,
      'fi',
    ])
  }

  writeExecutable(join(binDir, 'ip'), [
    '#!/bin/bash',
    'printf "ip %s\\n" "$*" >> "$CALLS_FILE"',
    'if [ "$*" = "-6 route show table all" ] || [ "$*" = "-6 route show default" ]; then',
    '  printf "%s" "${IPV6_DEFAULT_ROUTE:-}"',
    '  exit "${FAIL_IP_ROUTE:-0}"',
    'fi',
    'exit 0',
  ])
  writeExecutable(join(binDir, 'flock'), ['#!/bin/bash', 'printf "flock %s\\n" "$*" >> "$CALLS_FILE"'])
  writeExecutable(join(binDir, 'conntrack'), ['#!/bin/bash', 'printf "conntrack %s\\n" "$*" >> "$CALLS_FILE"'])
  writeExecutable(join(binDir, 'systemctl'), [
    '#!/bin/bash',
    'printf "systemctl %s\\n" "$*" >> "$CALLS_FILE"',
    '[ "$*" != "is-active --quiet sleepypod.service" ] || exit "${SLEEPYPOD_SERVICE_ACTIVE:-1}"',
  ])
  // Tests run unprivileged; production uses the real chown as root.
  writeExecutable(join(binDir, 'chown'), ['#!/bin/bash', 'printf "chown %s\\n" "$*" >> "$CALLS_FILE"'])
}

function runHelper(args: string[], extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  return spawnSync('/bin/bash', [helperPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CALLS_FILE: callsFile,
      STATE_DIR: root,
      SLEEPYPOD_IPV6_SYSCTL_ROOT: ipv6SysctlRoot,
      ...extraEnv,
    },
  })
}

function calls(): string[] {
  if (!existsSync(callsFile)) return []
  return readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-internet-control-'))
  binDir = join(root, 'bin')
  rulesDir = join(root, 'iptables')
  ipv6SysctlRoot = join(root, 'ipv6-conf')
  callsFile = join(root, 'calls.log')
  helperPath = join(root, 'sp-internet-control')
  mkdirSync(binDir)
  mkdirSync(rulesDir)
  for (const scope of ['all', 'default', 'eth0']) {
    const scopeDir = join(ipv6SysctlRoot, scope)
    mkdirSync(scopeDir, { recursive: true })
    writeFileSync(join(scopeDir, 'disable_ipv6'), '0\n')
  }
  writeCommandStubs()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('sp-internet-control', () => {
  it('rejects invalid or extra arguments before running firewall commands', () => {
    buildHelper()

    expect(runHelper(['invalid']).status).toBe(2)
    expect(runHelper(['block', 'extra']).status).toBe(2)
    expect(calls()).toEqual([])
  })

  it('blocks IPv4 and IPv6 with direct DROP rules and persists Pod 5 restore files', () => {
    buildHelper()

    const result = runHelper(['block'])

    expect(result.status, result.stderr).toBe(0)
    const log = calls()
    expect(log).toContain('iptables -A OUTPUT -j DROP')
    expect(log).toContain('ip6tables -A OUTPUT -j DROP')
    expect(log).toContain('iptables -C OUTPUT -j DROP')
    expect(log).toContain('ip6tables -C OUTPUT -j DROP')
    expect(log).toContain('iptables -A OUTPUT -p udp --sport 68 --dport 67 -d 255.255.255.255/32 -j ACCEPT')
    expect(log).toContain('iptables -A OUTPUT -p udp -d 224.0.0.251/32 --dport 5353 -j ACCEPT')
    expect(log).toContain('iptables -A OUTPUT -p udp -d 224.0.0.251/32 --sport 5353 -j ACCEPT')
    expect(log).toContain('iptables -A INPUT -p udp -d 224.0.0.251/32 --dport 5353 -j ACCEPT')
    expect(log).toContain('ip6tables -A OUTPUT -p udp -d ff02::fb/128 --dport 5353 -j ACCEPT')
    expect(log).toContain('ip6tables -A OUTPUT -p udp -d ff02::fb/128 --sport 5353 -j ACCEPT')
    expect(log).toContain('ip6tables -A INPUT -p udp -d ff02::fb/128 --dport 5353 -j ACCEPT')
    expect(log).toContain('ip6tables -A OUTPUT -p udp -d ff02::1:2/128 --sport 546 --dport 547 -j ACCEPT')
    expect(log).toContain('ip6tables -A OUTPUT -p ipv6-icmp -d ff02::/16 -j ACCEPT')
    expect(log).not.toContain('iptables -A OUTPUT -p udp --dport 5353 -j ACCEPT')
    expect(log).not.toContain('ip6tables -A OUTPUT -p ipv6-icmp -j ACCEPT')
    expect(log.some(line => line.includes('--ctstate') || line.startsWith('conntrack '))).toBe(false)
    expect(log.some(line => line.includes('-t nat') || line.includes('-t mangle'))).toBe(false)
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toContain('# iptables-save-2')
    expect(readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8')).toContain('# ip6tables-save-2')
    expect(readFileSync(join(rulesDir, 'rules.v4'), 'utf8')).toContain('# iptables-save-2')
    expect(readFileSync(join(rulesDir, 'rules.v6'), 'utf8')).toContain('# ip6tables-save-2')
    expect(log).toContain('systemctl reset-failed iptables.service')
    expect(log).toContain('systemctl reset-failed ip6tables.service')
  })

  it('sets ACCEPT policies before flushing when unblocking', () => {
    buildHelper()

    const result = runHelper(['unblock'])

    expect(result.status, result.stderr).toBe(0)
    const log = calls()
    expect(log.indexOf('iptables -P INPUT ACCEPT')).toBeLessThan(log.indexOf('iptables -F'))
    expect(log.indexOf('ip6tables -P INPUT ACCEPT')).toBeLessThan(log.indexOf('ip6tables -F'))
    expect(log.some(line => line.startsWith('iptables -A '))).toBe(false)
    expect(log.some(line => line.startsWith('ip6tables -A '))).toBe(false)
  })

  it('persists an existing open ruleset without mutating runtime chains', () => {
    buildHelper()

    const result = runHelper(['persist'])

    expect(result.status, result.stderr).toBe(0)
    const log = calls()
    expect(log.some(line => /^ip6?tables -(?:P|F|X|A|I|D)\b/.test(line))).toBe(false)
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toContain('# iptables-save-2')
    expect(readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8')).toContain('# ip6tables-save-2')
    expect(readFileSync(join(rulesDir, 'rules.v4'), 'utf8')).toBe(
      readFileSync(join(rulesDir, 'iptables.rules'), 'utf8'),
    )
    expect(readFileSync(join(rulesDir, 'rules.v6'), 'utf8')).toBe(
      readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8'),
    )
    expect(result.stdout).toContain('Current firewall state persisted')
  })

  it('temporarily unblocks both families without changing persisted policy', () => {
    buildHelper()
    writeFileSync(join(rulesDir, 'iptables.rules'), 'blocked-v4\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), 'blocked-v6\n')

    const result = runHelper(['temporary-unblock'])

    expect(result.status, result.stderr).toBe(0)
    const log = calls()
    expect(log).toContain('iptables -P OUTPUT ACCEPT')
    expect(log).toContain('ip6tables -P OUTPUT ACCEPT')
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toBe('blocked-v4\n')
    expect(readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8')).toBe('blocked-v6\n')
    expect(result.stdout).toContain('persisted policy unchanged')
  })

  it('ignores stray ip6tables tools when the kernel has no IPv6 family', () => {
    buildHelper()

    const result = runHelper(['block'], {
      SLEEPYPOD_IPV6_SYSCTL_ROOT: join(root, 'no-ipv6-kernel'),
    })

    expect(result.status, result.stderr).toBe(0)
    expect(calls().some(line => line.startsWith('ip6tables'))).toBe(false)
    expect(existsSync(join(rulesDir, 'iptables.rules'))).toBe(true)
    expect(existsSync(join(rulesDir, 'rules.v4'))).toBe(true)
    expect(existsSync(join(rulesDir, 'ip6tables.rules'))).toBe(false)
  })

  it('rejects a partial IPv6 toolchain before changing either family', () => {
    buildHelper()
    rmSync(join(binDir, 'ip6tables-save'))
    writeFileSync(join(rulesDir, 'ip6tables.rules'), 'stale-v6\n')
    writeFileSync(join(rulesDir, 'rules.v6'), 'stale-legacy-v6\n')

    const result = runHelper(['block'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ip6tables toolchain is incomplete')
    expect(calls().some(line => line.startsWith('ip6tables '))).toBe(false)
    expect(calls().some(line => /^iptables -(?:P|F|X|A|I|D)\b/.test(line))).toBe(false)
    expect(readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8')).toBe('stale-v6\n')
    expect(readFileSync(join(rulesDir, 'rules.v6'), 'utf8')).toBe('stale-legacy-v6\n')
    expect(existsSync(join(rulesDir, 'iptables.rules'))).toBe(false)
  })

  it('rejects an IPv6-capable kernel without an IPv6 firewall', () => {
    buildHelper({ ipv6: false })

    const result = runHelper(['block'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ip6tables toolchain is unavailable')
    expect(result.stderr).toContain('persistent IPv6 boundary')
    expect(calls().some(line => /^iptables -(?:P|F|X|A|I|D)\b/.test(line))).toBe(false)
  })

  it('restores runtime and persisted state when a firewall mutation fails', () => {
    buildHelper()
    writeFileSync(join(rulesDir, 'iptables.rules'), 'old-v4\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), 'old-v6\n')
    writeFileSync(join(rulesDir, 'rules.v4'), 'old-legacy-v4\n')
    writeFileSync(join(rulesDir, 'rules.v6'), 'old-legacy-v6\n')

    const result = runHelper(['block'], { FAIL_IPTABLES_ARGS: '-A OUTPUT -j DROP' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('restoring the previous state')
    expect(calls()).toContain('iptables-restore  :: *filter')
    expect(calls()).toContain('ip6tables-restore  :: *filter')
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toBe('old-v4\n')
    expect(readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8')).toBe('old-v6\n')
    expect(readFileSync(join(rulesDir, 'rules.v4'), 'utf8')).toBe('old-legacy-v4\n')
    expect(readFileSync(join(rulesDir, 'rules.v6'), 'utf8')).toBe('old-legacy-v6\n')
  })

  it('rolls back when validating the persisted post-state fails', () => {
    buildHelper()
    writeFileSync(join(rulesDir, 'iptables.rules'), 'old-v4\n')

    const result = runHelper(['unblock'], { FAIL_V4_RESTORE_TEST_AT: '2' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('restoring the previous state')
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toBe('old-v4\n')
    expect(calls().some(line => line.startsWith('iptables-restore  :: *filter'))).toBe(true)
  })

  it('forces and persists Local Only when runtime rollback fails after an unblock', () => {
    buildHelper()
    writeFileSync(join(rulesDir, 'iptables.rules'), 'old-open-v4\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), 'old-open-v6\n')
    writeFileSync(join(rulesDir, 'rules.v4'), 'old-open-legacy-v4\n')
    writeFileSync(join(rulesDir, 'rules.v6'), 'old-open-legacy-v6\n')

    const result = runHelper(['unblock'], {
      FAIL_IP6TABLES_ARGS: '-P INPUT ACCEPT',
      FAIL_V4_RESTORE_APPLY: '1',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Exact firewall rollback failed')
    expect(result.stderr).toContain('Emergency Local Only policy applied, persisted, and verified')
    expect(calls()).toContain('iptables -P OUTPUT DROP')
    expect(calls()).toContain('ip6tables -P OUTPUT DROP')
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toMatch(/# iptables-save-\d+/)
    expect(readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8')).toMatch(/# ip6tables-save-\d+/)
  })

  it('forces Local Only when restoring persisted backups fails', () => {
    buildHelper({ failRestoreFile: true })
    writeFileSync(join(rulesDir, 'iptables.rules'), 'old-v4\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), 'old-v6\n')
    writeFileSync(join(rulesDir, 'rules.v4'), 'old-legacy-v4\n')
    writeFileSync(join(rulesDir, 'rules.v6'), 'old-legacy-v6\n')

    const result = runHelper(['block'], { FAIL_V6_SAVE_AT: '2' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Exact firewall rollback failed')
    expect(result.stderr).toContain('Emergency Local Only policy applied, persisted, and verified')
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toMatch(/# iptables-save-\d+/)
    expect(readFileSync(join(rulesDir, 'rules.v4'), 'utf8')).toMatch(/# iptables-save-\d+/)
    expect(readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8')).toMatch(/# ip6tables-save-\d+/)
    expect(readFileSync(join(rulesDir, 'rules.v6'), 'utf8')).toMatch(/# ip6tables-save-\d+/)
  })
})

describe('sp-firewall-restore', () => {
  function runRestore(extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
    const restoreCopy = join(root, 'sp-firewall-restore')
    let source = readFileSync(firewallRestoreSourcePath, 'utf8')
    source = replaceExact(
      source,
      'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
      `export PATH="${shellDoubleQuoted(binDir)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
    )
    source = replaceExact(source, 'if [ "$EUID" -ne 0 ]; then', 'if false; then')
    writeFileSync(restoreCopy, source, { mode: 0o755 })
    return spawnSync('/bin/bash', [restoreCopy], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CALLS_FILE: callsFile,
        STATE_DIR: root,
        SLEEPYPOD_IPTABLES_RULES_DIR: rulesDir,
        SLEEPYPOD_FIREWALL_RESTORE_LOCK: join(root, 'restore.lock'),
        SLEEPYPOD_IPV6_SYSCTL_ROOT: ipv6SysctlRoot,
        ...extraEnv,
      },
    })
  }

  it('validates both families before applying either persisted policy', () => {
    writeFileSync(join(rulesDir, 'iptables.rules'), '*filter\nCOMMIT\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), '*filter\nCOMMIT\n')

    const result = runRestore()

    expect(result.status, result.stderr).toBe(0)
    const log = calls()
    const v4Test = log.findIndex(line => line.startsWith('iptables-restore --test'))
    const v6Test = log.findIndex(line => line.startsWith('ip6tables-restore --test'))
    const v4Apply = log.findIndex(line => line.startsWith('iptables-restore  ::'))
    expect(v4Test).toBeGreaterThan(-1)
    expect(v6Test).toBeGreaterThan(v4Test)
    expect(v4Apply).toBeGreaterThan(v6Test)
  })

  it('restores only IPv4 when stray IPv6 tools exist without a kernel family', () => {
    writeFileSync(join(rulesDir, 'iptables.rules'), '*filter\nCOMMIT\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), 'stale-v6\n')
    writeFileSync(join(rulesDir, 'rules.v6'), 'stale-legacy-v6\n')

    const result = runRestore({
      SLEEPYPOD_IPV6_SYSCTL_ROOT: join(root, 'no-ipv6-kernel'),
    })

    expect(result.status, result.stderr).toBe(0)
    expect(calls().some(line => line.startsWith('iptables-restore  ::'))).toBe(true)
    expect(calls().some(line => line.startsWith('ip6tables'))).toBe(false)
    expect(existsSync(join(rulesDir, 'ip6tables.rules'))).toBe(false)
    expect(existsSync(join(rulesDir, 'rules.v6'))).toBe(false)
  })

  it('rejects an empty persisted IPv6 policy before applying IPv4', () => {
    writeFileSync(join(rulesDir, 'iptables.rules'), '*filter\nCOMMIT\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), '')

    const result = runRestore()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing or empty persisted IPv6 policy')
    expect(calls()).toContain('iptables -P OUTPUT DROP')
    expect(calls()).toContain('ip6tables -P OUTPUT DROP')
    expect(calls().some(line => line.startsWith('iptables-restore'))).toBe(false)
  })

  it('forces both managed families closed when the IPv6 apply fails', () => {
    writeFileSync(join(rulesDir, 'iptables.rules'), '*filter\nCOMMIT\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), '*filter\nCOMMIT\n')

    const result = runRestore({ FAIL_V6_RESTORE_APPLY: '1' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('emergency Local Only policy applied')
    expect(calls()).toContain('iptables -P OUTPUT DROP')
    expect(calls()).toContain('iptables -F OUTPUT')
    expect(calls()).toContain('ip6tables -P OUTPUT DROP')
    expect(calls()).toContain('ip6tables -F OUTPUT')
  })

  it('fails closed when a managed IPv6 restore file is missing', () => {
    writeFileSync(join(rulesDir, 'iptables.rules'), '*filter\nCOMMIT\n')

    const result = runRestore()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing or empty persisted IPv6 policy')
    expect(calls()).toContain('iptables -P OUTPUT DROP')
    expect(calls()).toContain('ip6tables -P OUTPUT DROP')
  })

  it('fails closed when the IPv4 restore file is missing', () => {
    writeFileSync(join(rulesDir, 'ip6tables.rules'), '*filter\nCOMMIT\n')

    const result = runRestore()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing or empty persisted IPv4 policy')
    expect(calls()).toContain('iptables -P OUTPUT DROP')
    expect(calls()).toContain('ip6tables -P OUTPUT DROP')
  })

  it('fails closed instead of starting networking with a partial IPv6 toolchain', () => {
    rmSync(join(binDir, 'ip6tables-save'))
    writeFileSync(join(rulesDir, 'iptables.rules'), '*filter\nCOMMIT\n')

    const result = runRestore()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('complete ip6tables toolchain is unavailable')
    expect(calls()).toContain('iptables -P OUTPUT DROP')
    expect(calls()).toContain('ip6tables -P OUTPUT DROP')
    expect(calls().some(line => line.startsWith('ip6tables-restore'))).toBe(false)
    expect(calls().some(line => line.startsWith('iptables-restore'))).toBe(false)
  })

  it('reports an incomplete emergency boundary when ip6tables DROP fails', () => {
    writeFileSync(join(rulesDir, 'ip6tables.rules'), '*filter\nCOMMIT\n')

    const result = runRestore({ FAIL_IP6TABLES_ARGS: '-P OUTPUT DROP' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('emergency Local Only policy was incomplete')
    expect(calls()).toContain('iptables -P OUTPUT DROP')
    expect(calls()).toContain('ip6tables -P OUTPUT DROP')
  })
})

describe('sp-update firewall dispatch', () => {
  it('executes a safe root-owned helper before entering updater logic', () => {
    const dispatchHelper = join(root, 'dispatch-helper')
    const updateCopy = join(root, 'sp-update')
    const dispatchCalls = join(root, 'dispatch-calls')
    writeExecutable(dispatchHelper, [
      '#!/bin/bash',
      'printf "%s\\n" "$*" >> "$DISPATCH_CALLS"',
    ])

    let source = readFileSync(updateSourcePath, 'utf8')
    source = replaceExact(
      source,
      'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
      `export PATH="${shellDoubleQuoted(binDir)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
    )
    source = replaceExact(
      source,
      'MAINTENANCE_LOCK="/var/run/sleepypod-install.lock"',
      `MAINTENANCE_LOCK="${shellDoubleQuoted(join(root, 'maintenance.lock'))}"`,
    )
    source = replaceExact(
      source,
      'INTERNET_CONTROL_HELPER="/usr/local/bin/sp-internet-control"',
      `INTERNET_CONTROL_HELPER="${shellDoubleQuoted(dispatchHelper)}"`,
    )
    source = replaceExact(
      source,
      'HELPER_META="$(stat -c \'%u:%a\' "$INTERNET_CONTROL_HELPER" 2>/dev/null || true)"',
      'HELPER_META="0:755"',
    )
    writeFileSync(updateCopy, source, { mode: 0o755 })

    const result = spawnSync('/bin/bash', [updateCopy, '--internet-access', 'block'], {
      encoding: 'utf8',
      env: { ...process.env, CALLS_FILE: callsFile, DISPATCH_CALLS: dispatchCalls },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(dispatchCalls, 'utf8')).toBe('block\n')
    // If normal update initialization ran, it would print this banner before
    // failing on pod-only paths.
    expect(result.stdout).not.toContain('SleepyPod Update')
  })

  it('stops the app when direct-dispatch firewall recovery cannot be verified', () => {
    buildHelper()
    writeFileSync(join(rulesDir, 'iptables.rules'), 'old-open-v4\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), 'old-open-v6\n')
    writeFileSync(join(rulesDir, 'rules.v4'), 'old-open-legacy-v4\n')
    writeFileSync(join(rulesDir, 'rules.v6'), 'old-open-legacy-v6\n')

    const updateCopy = join(root, 'sp-update')
    let source = readFileSync(updateSourcePath, 'utf8')
    source = replaceExact(
      source,
      'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
      `export PATH="${shellDoubleQuoted(binDir)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
    )
    source = replaceExact(
      source,
      'MAINTENANCE_LOCK="/var/run/sleepypod-install.lock"',
      `MAINTENANCE_LOCK="${shellDoubleQuoted(join(root, 'maintenance.lock'))}"`,
    )
    source = replaceExact(
      source,
      'INTERNET_CONTROL_HELPER="/usr/local/bin/sp-internet-control"',
      `INTERNET_CONTROL_HELPER="${shellDoubleQuoted(helperPath)}"`,
    )
    source = replaceExact(
      source,
      'HELPER_META="$(stat -c \'%u:%a\' "$INTERNET_CONTROL_HELPER" 2>/dev/null || true)"',
      'HELPER_META="0:755"',
    )
    writeFileSync(updateCopy, source, { mode: 0o755 })

    const result = spawnSync('/bin/bash', [updateCopy, '--internet-access', 'unblock'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CALLS_FILE: callsFile,
        STATE_DIR: root,
        SLEEPYPOD_IPV6_SYSCTL_ROOT: ipv6SysctlRoot,
        FAIL_IP6TABLES_ARGS: '-P INPUT ACCEPT',
        FAIL_V4_RESTORE_APPLY: '1',
        FAIL_V4_SAVE_AT: '3',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('emergency Local Only recovery was incomplete')
    expect(result.stderr).toContain('Stopping sleepypod.service because firewall recovery is unverified')
    expect(calls()).toContain('systemctl stop sleepypod.service')
    expect(calls()).toContain('systemctl is-active --quiet sleepypod.service')
  })

  it('rejects extra firewall arguments without invoking the helper', () => {
    const updateCopy = join(root, 'sp-update')
    writeFileSync(updateCopy, readFileSync(updateSourcePath), { mode: 0o755 })

    const result = spawnSync('/bin/bash', [updateCopy, '--internet-access', 'block', 'extra'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage: sp-update --internet-access')
  })

  it('rejects a group-writable helper before execution', () => {
    const dispatchHelper = join(root, 'unsafe-helper')
    const updateCopy = join(root, 'sp-update')
    writeExecutable(dispatchHelper, ['#!/bin/bash', 'exit 0'])
    chmodSync(dispatchHelper, 0o775)

    let source = readFileSync(updateSourcePath, 'utf8')
    source = replaceExact(
      source,
      'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
      `export PATH="${shellDoubleQuoted(binDir)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
    )
    source = replaceExact(
      source,
      'MAINTENANCE_LOCK="/var/run/sleepypod-install.lock"',
      `MAINTENANCE_LOCK="${shellDoubleQuoted(join(root, 'maintenance.lock'))}"`,
    )
    source = replaceExact(
      source,
      'INTERNET_CONTROL_HELPER="/usr/local/bin/sp-internet-control"',
      `INTERNET_CONTROL_HELPER="${shellDoubleQuoted(dispatchHelper)}"`,
    )
    source = replaceExact(
      source,
      'HELPER_META="$(stat -c \'%u:%a\' "$INTERNET_CONTROL_HELPER" 2>/dev/null || true)"',
      'HELPER_META="0:775"',
    )
    writeFileSync(updateCopy, source, { mode: 0o755 })

    const result = spawnSync('/bin/bash', [updateCopy, '--internet-access', 'unblock'], {
      encoding: 'utf8',
      env: { ...process.env, CALLS_FILE: callsFile },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unsafe ownership/mode')
  })
})

describe('network privacy install and update migration', () => {
  function runPrivacyHelper(command: string, extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
    return spawnSync('/bin/bash', ['-c', `source "${shellDoubleQuoted(privacyHelpersSourcePath)}"; ${command}`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SLEEPYPOD_SKIP_OWNERSHIP: 'true',
        SLEEPYPOD_IPV6_SYSCTL_ROOT: ipv6SysctlRoot,
        ...extraEnv,
      },
    })
  }

  it.each([
    ['-P OUTPUT DROP', 'block'],
    ['-P OUTPUT ACCEPT\n-A OUTPUT -j DROP', 'block'],
    ['-P OUTPUT ACCEPT\n-A OUTPUT -j REJECT --reject-with icmp-port-unreachable', 'block'],
    ['-P OUTPUT ACCEPT\n-A OUTPUT -j SLEEPYPOD-BLOCK', 'block'],
    ['-P OUTPUT ACCEPT\n-A OUTPUT -d 203.0.113.1/32 -j DROP', 'unblock'],
    ['-P OUTPUT DROP\n-A OUTPUT -j ACCEPT', 'unblock'],
  ])('classifies firewall mode without treating narrow drops as Local Only', (rules, expected) => {
    const iptablesStub = join(binDir, 'mode-iptables')
    writeExecutable(iptablesStub, [
      '#!/bin/bash',
      '[ "$*" = "-S OUTPUT" ] || exit 2',
      'printf "%b\\n" "$IPTABLES_OUTPUT"',
    ])

    const result = runPrivacyHelper('detect_firewall_mode', {
      SLEEPYPOD_IPTABLES_BIN: iptablesStub,
      SLEEPYPOD_IP6TABLES_BIN: iptablesStub,
      SLEEPYPOD_IP6TABLES_SAVE_BIN: iptablesStub,
      SLEEPYPOD_IP6TABLES_RESTORE_BIN: iptablesStub,
      IPTABLES_OUTPUT: rules,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(expected)
  })

  it('refuses an ambiguous unconditional custom firewall target', () => {
    const iptablesStub = join(binDir, 'mode-iptables')
    writeExecutable(iptablesStub, [
      '#!/bin/bash',
      'printf "%s\\n" "-P OUTPUT ACCEPT" "-A OUTPUT -j USER-POLICY"',
    ])

    const result = runPrivacyHelper('detect_firewall_mode', {
      SLEEPYPOD_IPTABLES_BIN: iptablesStub,
      SLEEPYPOD_IP6TABLES_BIN: iptablesStub,
      SLEEPYPOD_IP6TABLES_SAVE_BIN: iptablesStub,
      SLEEPYPOD_IP6TABLES_RESTORE_BIN: iptablesStub,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ambiguous unconditional IPv4 OUTPUT target')
  })

  it('fails privacy-safe to blocked when IPv4 and IPv6 modes disagree', () => {
    const ipv4Stub = join(binDir, 'mode-iptables-v4')
    const ipv6Stub = join(binDir, 'mode-iptables-v6')
    writeExecutable(ipv4Stub, ['#!/bin/bash', 'printf "%s\\n" "-P OUTPUT ACCEPT"'])
    writeExecutable(ipv6Stub, ['#!/bin/bash', 'printf "%s\\n" "-P OUTPUT ACCEPT" "-A OUTPUT -j DROP"'])

    const result = runPrivacyHelper('detect_firewall_mode', {
      SLEEPYPOD_IPTABLES_BIN: ipv4Stub,
      SLEEPYPOD_IP6TABLES_BIN: ipv6Stub,
      SLEEPYPOD_IP6TABLES_SAVE_BIN: ipv6Stub,
      SLEEPYPOD_IP6TABLES_RESTORE_BIN: ipv6Stub,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('block')
  })

  it('uses only IPv4 semantics when stray IPv6 tools exist without a kernel family', () => {
    const ipv4Stub = join(binDir, 'mode-iptables-v4')
    const ipv6Stub = join(binDir, 'mode-iptables-v6')
    writeExecutable(ipv4Stub, ['#!/bin/bash', 'printf "%s\\n" "-P OUTPUT DROP"'])
    writeExecutable(ipv6Stub, ['#!/bin/bash', 'exit 99'])

    const result = runPrivacyHelper('detect_firewall_mode; firewall_state_matches block', {
      SLEEPYPOD_IPV6_SYSCTL_ROOT: join(root, 'no-ipv6-kernel'),
      SLEEPYPOD_IPTABLES_BIN: ipv4Stub,
      SLEEPYPOD_IP6TABLES_BIN: ipv6Stub,
      SLEEPYPOD_IP6TABLES_SAVE_BIN: ipv6Stub,
      SLEEPYPOD_IP6TABLES_RESTORE_BIN: ipv6Stub,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('block')
  })

  it('refuses mode classification when the IPv6 toolchain is partial', () => {
    const ipv4Stub = join(binDir, 'mode-iptables-v4')
    const ipv6Stub = join(binDir, 'mode-iptables-v6')
    writeExecutable(ipv4Stub, ['#!/bin/bash', 'printf "%s\\n" "-P OUTPUT DROP"'])
    writeExecutable(ipv6Stub, ['#!/bin/bash', 'printf "%s\\n" "-P OUTPUT ACCEPT"'])
    const result = runPrivacyHelper('detect_firewall_mode; firewall_state_matches block', {
      CALLS_FILE: callsFile,
      SLEEPYPOD_IP_BIN: join(binDir, 'ip'),
      SLEEPYPOD_IPTABLES_BIN: ipv4Stub,
      SLEEPYPOD_IP6TABLES_BIN: ipv6Stub,
      SLEEPYPOD_IP6TABLES_SAVE_BIN: '',
      SLEEPYPOD_IP6TABLES_RESTORE_BIN: '',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ip6tables toolchain is incomplete')
  })

  it('refuses mode classification for an unmanaged IPv6-capable kernel', () => {
    const ipv4Stub = join(binDir, 'mode-iptables-v4')
    const ipv6Stub = join(binDir, 'mode-iptables-v6')
    writeExecutable(ipv4Stub, ['#!/bin/bash', 'printf "%s\\n" "-P OUTPUT ACCEPT"'])
    writeExecutable(ipv6Stub, ['#!/bin/bash', 'printf "%s\\n" "-P OUTPUT ACCEPT"'])

    const result = runPrivacyHelper('detect_firewall_mode', {
      CALLS_FILE: callsFile,
      IPV6_DEFAULT_ROUTE: 'default via fe80::1 dev eth0\n',
      SLEEPYPOD_IP_BIN: join(binDir, 'ip'),
      SLEEPYPOD_IPTABLES_BIN: ipv4Stub,
      SLEEPYPOD_IP6TABLES_BIN: ipv6Stub,
      SLEEPYPOD_IP6TABLES_SAVE_BIN: '',
      SLEEPYPOD_IP6TABLES_RESTORE_BIN: '',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ip6tables toolchain is incomplete')
  })

  it('installs and refreshes a complete dual-stack hosts block idempotently', () => {
    const hostsFile = join(root, 'hosts')
    writeFileSync(hostsFile, '127.0.0.1 localhost\n')

    const first = runPrivacyHelper('ensure_telemetry_hosts_block', {
      SLEEPYPOD_HOSTS_FILE: hostsFile,
    })
    const second = runPrivacyHelper('ensure_telemetry_hosts_block', {
      SLEEPYPOD_HOSTS_FILE: hostsFile,
    })

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    const hosts = readFileSync(hostsFile, 'utf8')
    expect(hosts.match(/# BEGIN sleepypod-telemetry-block/g)).toHaveLength(1)
    expect(hosts.match(/# END sleepypod-telemetry-block/g)).toHaveLength(1)
    expect(hosts).toContain('0.0.0.0 raw-api-upload.8slp.net')
    expect(hosts).toContain(':: raw-api-upload.8slp.net')
    expect(hosts).toContain('0.0.0.0 device-api-ws.8slp.net')
    expect(hosts).toContain(':: device-api-ws.8slp.net')
  })

  it('rejects malformed hosts markers without changing the file', () => {
    const hostsFile = join(root, 'hosts')
    const malformed = '127.0.0.1 localhost\n# BEGIN sleepypod-telemetry-block\n'
    writeFileSync(hostsFile, malformed)

    const result = runPrivacyHelper('ensure_telemetry_hosts_block', {
      SLEEPYPOD_HOSTS_FILE: hostsFile,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('malformed or duplicate')
    expect(readFileSync(hostsFile, 'utf8')).toBe(malformed)
  })

  it('validates and installs the updater sudoers fragment', () => {
    const sudoersFile = join(root, 'sudoers', 'sleepypod-update')
    const visudoStub = join(binDir, 'visudo')
    writeExecutable(visudoStub, ['#!/bin/bash', 'exit 0'])

    const result = runPrivacyHelper('install_sleepypod_update_sudoers', {
      SLEEPYPOD_SUDOERS_FILE: sudoersFile,
      SLEEPYPOD_VISUDO_BIN: visudoStub,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(sudoersFile, 'utf8')).toContain(
      'sleepypod ALL=(root) NOPASSWD: /usr/local/bin/sp-update',
    )
  })

  it('writes and validates the migration marker atomically', () => {
    const marker = join(root, 'etc', 'firewall-policy-v1')
    mkdirSync(join(root, 'etc'))
    writeFileSync(marker, 'truncated')

    const result = runPrivacyHelper(
      'network_privacy_migrated && exit 9; mark_network_privacy_migrated; network_privacy_migrated',
      { SLEEPYPOD_FIREWALL_MIGRATION_MARKER: marker },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('firewall-policy-v1\n')
  })

  it('installs a boot-active firewall restore unit', () => {
    const unit = join(root, 'systemd', 'sleepypod-firewall-restore.service')
    const restoreTool = join(root, 'sp-firewall-restore')
    writeExecutable(restoreTool, ['#!/bin/bash', 'exit 0'])

    const result = runPrivacyHelper('install_firewall_restore_service', {
      CALLS_FILE: callsFile,
      SLEEPYPOD_FIREWALL_RESTORE_UNIT: unit,
      SLEEPYPOD_FIREWALL_RESTORE_TOOL: restoreTool,
      SLEEPYPOD_SYSTEMCTL_BIN: join(binDir, 'systemctl'),
    })

    expect(result.status, result.stderr).toBe(0)
    const source = readFileSync(unit, 'utf8')
    expect(source).toContain('Before=network-pre.target NetworkManager.service')
    expect(source).toContain('WantedBy=multi-user.target')
    expect(source).toContain('RequiredBy=NetworkManager.service')
    expect(source).toContain(`ExecStart=${restoreTool}`)
    expect(calls()).toContain('systemctl daemon-reload')
    expect(calls()).toContain('systemctl enable sleepypod-firewall-restore.service')
  })

  it('orders privacy setup before WAN use and convergence before service startup', () => {
    const install = readFileSync(installSourcePath, 'utf8')
    const update = readFileSync(updateSourcePath, 'utf8')
    const maintenance = readFileSync(maintenanceSourcePath, 'utf8')
    const updateCard = readFileSync(updateCardSourcePath, 'utf8')

    expect(install.indexOf('if ! ensure_telemetry_hosts_block; then')).toBeLessThan(
      install.indexOf('curl -sf --max-time 10 https://github.com'),
    )
    expect(install).toContain('FINAL_FIREWALL_MODE=block')
    expect(install.lastIndexOf('converge_firewall_mode "$FINAL_FIREWALL_MODE"')).toBeGreaterThan(
      install.indexOf('Installing Biometrics Modules'),
    )
    expect(install.lastIndexOf('converge_firewall_mode "$FINAL_FIREWALL_MODE"')).toBeLessThan(
      install.lastIndexOf('systemctl start sleepypod.service'),
    )
    expect(install).toContain('install_firewall_restore_service')
    expect(install.lastIndexOf('install_firewall_restore_service')).toBeLessThan(
      install.lastIndexOf('converge_firewall_mode "$FINAL_FIREWALL_MODE"'),
    )
    expect(install).toContain('network_privacy_state_matches "$FINAL_FIREWALL_MODE"')
    expect(install).toContain('LOCKFILE="/var/run/sleepypod-install.lock"')
    const ipv6Preflight = install.lastIndexOf('if ! network_privacy_ipv6_supported; then')
    expect(ipv6Preflight).toBeGreaterThan(install.indexOf('preflight_free_sleep_conflict\n'))
    expect(ipv6Preflight).toBeLessThan(install.indexOf('if ! systemctl stop sleepypod.service; then'))
    expect(ipv6Preflight).toBeLessThan(install.indexOf('purge_free_sleep\n', ipv6Preflight))
    expect(install.indexOf('if ! systemctl stop sleepypod.service; then')).toBeLessThan(
      install.indexOf('FINAL_FIREWALL_MODE="$(detect_firewall_mode)"'),
    )

    const capturedMode = update.indexOf('PRE_UPDATE_FIREWALL_MODE="$(detect_firewall_mode)"')
    expect(update.indexOf('if ! systemctl stop sleepypod.service; then')).toBeLessThan(capturedMode)
    expect(capturedMode).toBeLessThan(update.indexOf('"$FIREWALL_HELPER" temporary-unblock', capturedMode))
    expect(update.indexOf('if ! ensure_telemetry_hosts_block; then')).toBeLessThan(
      update.indexOf('curl -sf --max-time 10 https://github.com'),
    )
    expect(update.indexOf('converge_firewall_mode "$PRE_UPDATE_FIREWALL_MODE"')).toBeLessThan(
      update.lastIndexOf('systemctl start sleepypod.service'),
    )
    expect(update).toContain('install_sleepypod_update_sudoers')
    expect(update).toContain('install_firewall_restore_service')
    expect(update.lastIndexOf('install_firewall_restore_service')).toBeLessThan(
      update.indexOf('converge_firewall_mode "$PRE_UPDATE_FIREWALL_MODE"'),
    )
    expect(update).toContain('network_privacy_state_matches "$PRE_UPDATE_FIREWALL_MODE"')
    expect(update).toContain('MAINTENANCE_LOCK="/var/run/sleepypod-install.lock"')
    expect(update.match(/flock -n 200/g)).toHaveLength(2)
    expect(maintenance).toContain('Network privacy migration complete')
    expect(maintenance).toContain('MIGRATION_MODE=block')
    expect(maintenance).toContain('/usr/local/bin/sp-internet-control block')
    expect(maintenance).toContain('/tmp/sleepypod-rollback) continue')
    expect(maintenance).not.toContain('pgrep -f')
    expect(maintenance).toContain('/tmp/sleepypod-install.log) continue')
    expect(updateCard).toContain('if (versionChanged)')
    expect(updateCard).not.toContain('versionChanged || sawDownRef.current')
  })
})

describe('sp-uninstall firewall cleanup', () => {
  it('removes SleepyPod helpers and leaves valid stock restore inputs', () => {
    const source = readFileSync(uninstallSourcePath, 'utf8')

    expect(source).toContain('rm -f /usr/local/bin/sp-internet-control')
    expect(source).toContain('rm -f /usr/local/bin/sp-firewall-restore')
    expect(source).toContain('rm -f /usr/local/bin/sp-network-privacy')
    expect(source).toContain('sleepypod-firewall-restore.service')
    expect(source).toContain('rm -f /etc/sudoers.d/sleepypod-update')
    expect(source).toContain('iptables-save > /etc/iptables/iptables.rules')
    expect(source).toContain('cp -f /etc/iptables/iptables.rules /etc/iptables/rules.v4')
    expect(source).not.toContain('disable_ipv6')
  })
})
