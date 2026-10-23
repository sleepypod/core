import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const installer = readFileSync(new URL('../scripts/install', import.meta.url), 'utf8')
const wanted = installer.match(/^NODE_WANTED=(\d+)$/m)[1]
const check = installer.slice(
  installer.indexOf('node_version_is_supported()'),
  installer.indexOf('CURRENT_NODE_VERSION='),
)

test('installer is valid Bash', () => {
  execFileSync('bash', ['-n', new URL('../scripts/install', import.meta.url).pathname])
})

for (const [version, accepted] of [
  ['', false],
  ['v22.23.4', false],
  ['v24.16.0', false],
  ['v24.22.0', false],
  ['v24.22.1', true],
  ['v24.22.2', true],
  ['v24.23.0', true],
  ['v24.22.1-rc.1', false],
  ['v26.12.0', false],
]) {
  test(`installer ${accepted ? 'keeps' : 'replaces'} ${version || 'missing Node'}`, () => {
    const result = spawnSync('bash', [
      '-c', `NODE_WANTED=${wanted}\n${check}\nnode_version_is_supported "$1"`, 'bash', version,
    ])
    assert.equal(result.status, accepted ? 0 : 1)
  })
}
