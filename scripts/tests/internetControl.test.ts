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

let root: string
let binDir: string
let rulesDir: string
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

function buildHelper(options: { ipv6?: boolean } = {}): void {
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

  writeFileSync(helperPath, source, { mode: 0o755 })
}

function writeCommandStubs(): void {
  writeExecutable(join(binDir, 'iptables'), [
    '#!/bin/bash',
    'printf "iptables %s\\n" "$*" >> "$CALLS_FILE"',
    'if [ "${FAIL_IPTABLES_ARGS:-}" = "$*" ]; then exit 1; fi',
  ])
  writeExecutable(join(binDir, 'ip6tables'), [
    '#!/bin/bash',
    'printf "ip6tables %s\\n" "$*" >> "$CALLS_FILE"',
    'if [ "${FAIL_IP6TABLES_ARGS:-}" = "$*" ]; then exit 1; fi',
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
      `printf '*filter\\n# ${family}-save-%s\\nCOMMIT\\n' "$count"`,
    ])
    writeExecutable(join(binDir, `${family}-restore`), [
      '#!/bin/bash',
      'payload="$(cat)"',
      `printf "${family}-restore %s :: %s\\n" "$*" "$payload" >> "$CALLS_FILE"`,
      'if [ "${FAIL_RESTORE_TEST:-0}" = 1 ] && [ "${1:-}" = "--test" ]; then exit 1; fi',
    ])
  }

  writeExecutable(join(binDir, 'flock'), ['#!/bin/bash', 'printf "flock %s\\n" "$*" >> "$CALLS_FILE"'])
  writeExecutable(join(binDir, 'conntrack'), ['#!/bin/bash', 'printf "conntrack %s\\n" "$*" >> "$CALLS_FILE"'])
  writeExecutable(join(binDir, 'systemctl'), ['#!/bin/bash', 'printf "systemctl %s\\n" "$*" >> "$CALLS_FILE"'])
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
  callsFile = join(root, 'calls.log')
  helperPath = join(root, 'sp-internet-control')
  mkdirSync(binDir)
  mkdirSync(rulesDir)
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

  it('works on a pod without an ip6tables toolchain', () => {
    buildHelper({ ipv6: false })

    const result = runHelper(['block'])

    expect(result.status, result.stderr).toBe(0)
    expect(calls().some(line => line.startsWith('ip6tables'))).toBe(false)
    expect(existsSync(join(rulesDir, 'iptables.rules'))).toBe(true)
    expect(existsSync(join(rulesDir, 'ip6tables.rules'))).toBe(false)
  })

  it('restores runtime and persisted state when a firewall mutation fails', () => {
    buildHelper()
    writeFileSync(join(rulesDir, 'iptables.rules'), 'old-v4\n')
    writeFileSync(join(rulesDir, 'ip6tables.rules'), 'old-v6\n')

    const result = runHelper(['block'], { FAIL_IPTABLES_ARGS: '-A OUTPUT -j DROP' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('restoring the previous state')
    expect(calls()).toContain('iptables-restore  :: *filter')
    expect(calls()).toContain('ip6tables-restore  :: *filter')
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toBe('old-v4\n')
    expect(readFileSync(join(rulesDir, 'ip6tables.rules'), 'utf8')).toBe('old-v6\n')
  })

  it('rolls back when validating the persisted post-state fails', () => {
    buildHelper()
    writeFileSync(join(rulesDir, 'iptables.rules'), 'old-v4\n')

    const result = runHelper(['unblock'], { FAIL_RESTORE_TEST: '1' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('restoring the previous state')
    expect(readFileSync(join(rulesDir, 'iptables.rules'), 'utf8')).toBe('old-v4\n')
    expect(calls().some(line => line.startsWith('iptables-restore  :: *filter'))).toBe(true)
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
      env: { ...process.env, DISPATCH_CALLS: dispatchCalls },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(dispatchCalls, 'utf8')).toBe('block\n')
    // If normal update initialization ran, it would print this banner before
    // failing on pod-only paths.
    expect(result.stdout).not.toContain('SleepyPod Update')
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
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unsafe ownership/mode')
  })
})

describe('sp-uninstall firewall cleanup', () => {
  it('removes the helper and both Pod 5 restore files', () => {
    const source = readFileSync(uninstallSourcePath, 'utf8')

    expect(source).toContain('rm -f /usr/local/bin/sp-internet-control')
    expect(source).toContain('/etc/iptables/iptables.rules /etc/iptables/ip6tables.rules')
  })
})
