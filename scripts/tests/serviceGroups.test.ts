// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const helper = resolve('scripts/lib/service-group-helpers')
let root: string
let groupFile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-groups-'))
  groupFile = join(root, 'group')
  writeFileSync(groupFile, 'dac:x:1000:sleepypod\nsystemd-journal:x:992:\nadm:x:4:\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(script: string) {
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail; source "$HELPER"; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, HELPER: helper, SLEEPYPOD_GROUP_FILE: groupFile, TEST_ROOT: root },
  })
}

describe('service groups on minimal Yocto images', () => {
  it('finds exact local groups without getent or any external commands', () => {
    const result = run('PATH=/nonexistent; sleepypod_group_exists dac; ! sleepypod_group_exists da; sleepypod_journal_group')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('systemd-journal')
  })
  it('falls back to adm and tolerates images with neither journal group', () => {
    writeFileSync(groupFile, 'adm:x:4:\n')
    expect(run('PATH=/nonexistent; sleepypod_journal_group').stdout.trim()).toBe('adm')
    writeFileSync(groupFile, 'dac:x:1000:sleepypod\n')
    const result = run('PATH=/nonexistent; repair_sleepypod_journal_access')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
  it('retains NSS lookup and falls back when getent fails', () => {
    writeFileSync(groupFile, 'adm:x:4:\n')
    expect(run('getent() { return 0; }; sleepypod_journal_group').stdout.trim()).toBe('systemd-journal')
    expect(run('getent() { return 2; }; sleepypod_journal_group').stdout.trim()).toBe('adm')
  })
  it('appends membership once, preserving dac and custom groups', () => {
    const result = run(`
      getent() { return 127; }
      id() { printf '%s\\n' "sleepypod dac custom \${ADDED_GROUP:-}"; }
      usermod() { printf '%s\\n' "$*" >> "$TEST_ROOT/calls"; ADDED_GROUP=$3; }
      repair_sleepypod_journal_access
      repair_sleepypod_journal_access
    `)
    expect(result.status).toBe(0)
    expect(readFileSync(join(root, 'calls'), 'utf8')).toBe('-a -G systemd-journal sleepypod\n')
  })
  it('reports membership repair failure to the best-effort startup caller', () => {
    const result = run('getent() { return 127; }; id() { echo "sleepypod dac"; }; usermod() { return 1; }; repair_sleepypod_journal_access')
    expect(result.status).toBe(1)
  })
})
