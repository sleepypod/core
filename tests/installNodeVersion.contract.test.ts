import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const installerPath = resolve(process.cwd(), 'scripts/install')
const installer = readFileSync(installerPath, 'utf8')
const wanted = /^NODE_WANTED=(\d+)$/m.exec(installer)?.[1]
const check = installer.slice(
  installer.indexOf('node_version_is_supported()'),
  installer.indexOf('CURRENT_NODE_VERSION='),
)

describe('installer Node.js version check', () => {
  test('installer is valid Bash', () => {
    execFileSync('bash', ['-n', installerPath])
  })

  test.each([
    ['', false],
    ['v22.23.4', false],
    ['v24.16.0', false],
    ['v24.22.0', false],
    ['v24.22.1', true],
    ['v24.22.2', true],
    ['v24.23.0', true],
    ['v24.22.1-rc.1', false],
    ['v26.12.0', false],
  ])('version %j accepted=%s', (version, accepted) => {
    const result = spawnSync('bash', [
      '-c', `NODE_WANTED=${wanted}\n${check}\nnode_version_is_supported "$1"`, 'bash', version,
    ])
    expect(result.status).toBe(accepted ? 0 : 1)
  })
})
