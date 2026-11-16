// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string
const directories = ['/persistent/deviceinfo', '/deviceinfo']

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-socket-perms-'))
  for (const dir of directories) {
    mkdirSync(root + dir, { recursive: true })
    chmodSync(root + dir, 0o755)
    writeFileSync(root + dir + '/device.json', 'preserve firmware data')
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Run the real permission blocks without invoking installation or unrelated
// maintenance. Stub Linux account/ownership inspection; chmod acts on real dirs.
function run(script: string, groupExists = true, chownFails = false) {
  const source = readFileSync(resolve(script), 'utf8')
  const block = script.endsWith('/install')
    ? source.slice(source.indexOf('mkdir -p /persistent/deviceinfo'), source.indexOf('groupadd --force sleepypod'))
    : source.slice(source.indexOf('# 5. Self-heal'), source.indexOf('# 6. Self-heal'))
  expect(block).not.toBe('')
  const sandboxed = block.replace(/\/(?:persistent\/deviceinfo|deviceinfo)\b/g, path => root + path)
  return spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', `
    getent() { return ${groupExists ? 0 : 1}; }
    stat() { case "$2" in '%U:%G') echo root:root;; '%a') echo 755;; *) return 1;; esac; }
    chown() { printf '%s\\n' "$*" >> "$OWNERSHIP_LOG"; return ${chownFails ? 1 : 0}; }
    ${sandboxed}
  `], {
    encoding: 'utf8',
    env: { ...process.env, OWNERSHIP_LOG: join(root, 'ownership') },
  })
}

describe.each(['scripts/install', 'scripts/bin/sp-maintenance'])('%s DAC directory permissions', (script) => {
  it('repairs both the separate Pod 3 directory and persistent layout without changing firmware data', () => {
    const result = run(script)
    expect(result.status, result.stderr).toBe(0)
    for (const dir of directories) {
      expect(statSync(root + dir).mode & 0o7777).toBe(0o2770)
      expect(readFileSync(join(root, 'ownership'), 'utf8')).toContain(`root:dac ${root}${dir}`)
      expect(readFileSync(root + dir + '/device.json', 'utf8')).toBe('preserve firmware data')
    }
  })

  it('leaves permissions alone when the firmware group is absent', () => {
    expect(run(script, false).status).toBe(0)
    for (const dir of directories) expect(statSync(root + dir).mode & 0o7777).toBe(0o755)
  })

  it('fails startup or installation when ownership cannot be repaired', () => {
    expect(run(script, true, true).status).not.toBe(0)
  })
})
