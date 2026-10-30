import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const installer = readFileSync(join(process.cwd(), 'scripts/install'), 'utf8')
const scratch: string[] = []
afterEach(() => scratch.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

function temp() {
  const directory = mkdtempSync(join(tmpdir(), 'sleepypod-install-source-'))
  scratch.push(directory)
  return directory
}

// Exercise the actual bootstrap blocks without running hardware installation.
function block(start: string, end: string) {
  const beginning = installer.indexOf(start)
  const ending = installer.indexOf(end, beginning)
  if (beginning < 0 || ending < 0) throw new Error('Installer block is missing')
  return installer.slice(beginning, ending)
}

function configure(options: { saved?: string, override?: string, local?: boolean, artifact?: string } = {}) {
  const directory = temp()
  const metadata = join(directory, 'github-repo')
  if (options.saved !== undefined) writeFileSync(metadata, options.saved)
  const script = [
    'set -euo pipefail',
    block('INSTALL_DIR="/home/dac/sleepypod-core"', 'SCRIPT_DEFAULT_BRANCH='),
    block('# Keep the installed source outside', '# Create or preserve environment file'),
  ].join('\n').replaceAll('/etc/sleepypod/github-repo', metadata)
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
    ...process.env,
    INSTALL_LOCAL: options.local ? 'true' : 'false',
    ARTIFACT_URL_OVERRIDE: options.artifact ?? '',
    SLEEPYPOD_GITHUB_REPO: options.override ?? '',
  } })
  return { result, repository: existsSync(metadata) ? readFileSync(metadata, 'utf8') : null }
}

describe('installer repository identity', () => {
  it.each([
    [{}, 'sleepypod/core\n'],
    [{ override: 'lucaandrea/sleepypod-core' }, 'lucaandrea/sleepypod-core\n'],
    [{ saved: 'lucaandrea/sleepypod-core\n' }, 'lucaandrea/sleepypod-core\n'],
    [{ local: true }, null],
    [{ artifact: 'https://example.test/pinned.zip' }, null],
    [{ local: true, override: 'lucaandrea/sleepypod-core' }, 'lucaandrea/sleepypod-core\n'],
  ] as const)('records only a known source: %j', (options, expected) => {
    const { result, repository } = configure(options)
    expect(result.status, result.stderr).toBe(0)
    expect(repository).toBe(expected)
  })

  it.each(['', 'owner/..', 'owner/repo\nother/repo', 'https://github.com/owner/repo'])('rejects malformed saved source %j', (saved) => {
    const { result, repository } = configure({ saved })
    expect(result.status).not.toBe(0)
    expect(repository).toBe(saved)
  })

  it.each([false, true])('honors a pinned artifact without fetching another source (download failure=%s)', (fail) => {
    const directory = temp()
    const bundle = join(directory, 'bundle')
    const bin = join(directory, 'bin')
    const log = join(directory, 'log')
    mkdirSync(bundle)
    mkdirSync(bin)
    writeFileSync(join(bundle, 'package.json'), '{}')
    const archive = join(directory, 'sleepypod-core.tar.gz')
    expect(spawnSync('tar', ['czf', archive, '-C', bundle, '.']).status).toBe(0)
    const artifact = join(directory, 'artifact.zip')
    expect(spawnSync('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1],"w").write(sys.argv[2],"sleepypod-core.tar.gz")', artifact, archive]).status).toBe(0)
    writeFileSync(join(bin, 'curl'), `#!/bin/bash
echo "$*" >> "$TEST_LOG"
[ "$TEST_FAIL" != 1 ] || exit 22
[[ "$*" == *https://example.test/pinned.zip* ]] || exit 99
while [ "$#" -gt 0 ] && [ "$1" != -o ]; do shift; done
cp "$TEST_ARTIFACT" "$2"
`, { mode: 0o755 })
    const script = `set -euo pipefail\n${block('  DOWNLOAD_BRANCH=', '  # Clean old files if updating')}`
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: directory,
      GITHUB_REPO: 'lucaandrea/sleepypod-core', INSTALL_BRANCH: '', SCRIPT_DEFAULT_BRANCH: 'main',
      ARTIFACT_URL_OVERRIDE: 'https://example.test/pinned.zip',
      TEST_LOG: log, TEST_ARTIFACT: artifact, TEST_FAIL: fail ? '1' : '0',
    } })
    expect(result.status === 0, result.stderr).toBe(!fail)
    const requests = readFileSync(log, 'utf8')
    expect(requests.trim().split('\n')).toHaveLength(1)
    expect(requests).toContain('https://example.test/pinned.zip')
    expect(requests).not.toContain('api.github.com')
    expect(requests).not.toContain('archive/refs/heads')
    if (fail) expect(result.stderr).toContain('refusing a different source')
  })
})
