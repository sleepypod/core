import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const repo = process.cwd()
// Git hooks export GIT_DIR/GIT_INDEX_FILE/etc. Clear them for every fixture
// subprocess so a pre-push test cannot operate on the invoking repository.
const testEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  NODE_ENV: process.env.NODE_ENV,
}
const scratch: string[] = []
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'sleepypod-update-test-'))
  scratch.push(dir)
  return dir
}
function put(path: string, content: string) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content, { mode: 0o755 })
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const helper = `
SAVED_IPTABLES=""
WAN_WAS_BLOCKED=false
wan_is_blocked() { [ "$TEST_WAN_BLOCKED" = 1 ]; }
unblock_wan() { echo unblock >> "$TEST_LOG"; }
restore_wan() { echo restore >> "$TEST_LOG"; }
`
function updater(options: { invalid?: boolean, noAsset?: boolean, archive?: boolean, status?: string, blocked?: boolean, pnpmFail?: boolean, version?: string, downloadFail?: boolean, backupFail?: boolean, symlinkInstall?: boolean, lowTempSpace?: boolean, branch?: string, repository?: string | null, repositoryOverride?: string, repositorySymlink?: boolean, startFail?: boolean } = {}) {
  const dir = temp()
  const app = join(dir, 'app')
  const bundle = join(dir, 'bundle')
  const bin = join(dir, 'bin')
  const log = join(dir, 'log')
  mkdirSync(join(dir, 'data'))
  mkdirSync(join(dir, 'stage'))
  const repositoryFile = join(dir, 'config/github-repo')
  if (options.repository !== null) put(repositoryFile, options.repository ?? 'sleepypod/core\n')
  if (options.repositorySymlink) {
    rmSync(repositoryFile)
    put(join(dir, 'untrusted-repository'), 'untrusted/core\n')
    symlinkSync(join(dir, 'untrusted-repository'), repositoryFile)
  }
  put(join(app, 'old.txt'), 'old code')
  put(join(app, '.next/standalone/server.js'), 'old standalone server')
  const installPath = options.symlinkInstall ? join(dir, 'install-link') : app
  if (options.symlinkInstall) symlinkSync(app, installPath)
  put(join(app, '.env'), 'POD_SECRET=keep')
  put(join(app, 'scripts/lib/iptables-helpers'), helper)
  put(join(bundle, 'scripts/lib/iptables-helpers'), helper)
  put(join(bundle, 'package.json'), '{"packageManager":"pnpm@10.34.5"}')
  put(join(bundle, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
  put(join(bundle, '.next/required-server-files.json'), '{}')
  put(join(bundle, '.next/standalone/server.js'), 'new standalone server')
  if (!options.invalid) put(join(bundle, '.next/BUILD_ID'), 'new-build')
  put(join(bundle, '.git-info'), '{"branch":"fix/test","commitHash":"abc1234"}')
  put(join(bundle, '.env'), 'LOCAL_SECRET=do-not-copy')
  put(join(bundle, 'node_modules/foreign.node'), 'wrong architecture')
  const archive = join(dir, 'bundle.tar.gz')
  expect(spawnSync('tar', ['czf', archive, '-C', bundle, '.']).status).toBe(0)
  // nightly.link serves the build.yml artifact as a zip wrapping the tarball.
  const artifactZip = join(dir, 'artifact.zip')
  expect(spawnSync('python3', ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1], "w").write(sys.argv[2], "sleepypod-core.tar.gz")', artifactZip, archive]).status).toBe(0)
  let script = readFileSync(join(repo, 'scripts/bin/sp-update'), 'utf8')
  const rewrites: [string, string][] = [
    ['export PATH="/usr/local/bin:$PATH"', ''],
    ['/home/dac/sleepypod-core', installPath],
    ['/persistent/sleepypod-data', join(dir, 'data')],
    ['/etc/sleepypod/data-dir', join(dir, 'data-dir')],
    ['/etc/sleepypod/github-repo', repositoryFile],
    ['/etc/systemd/system', join(dir, 'systemd')],
    ['/etc/hosts', join(dir, 'hosts')],
  ]
  for (const [from, to] of rewrites) {
    expect(script).toContain(from)
    script = script.replaceAll(from, to)
  }
  put(join(dir, 'hosts'), '# BEGIN sleepypod-telemetry-block')
  put(join(dir, 'update'), script)
  put(join(bin, 'systemctl'), '#!/bin/bash\necho "systemctl $*" >> "$TEST_LOG"\nif [ "$1" = is-active ] && [ "$TEST_START_FAIL" = 1 ]; then exit 1; fi\n')
  put(join(bin, 'df'), `#!/bin/bash
available=900
if [ "$2" = "$TMPDIR" ]; then available=$TEST_TEMP_SPACE; fi
echo 'Filesystem Size Used Available Use% Mounted'
echo "fixture 1000 100 $available 10% /"
`)
  put(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n')
  put(join(bin, 'pnpm'), `#!/bin/bash
if [ "$1" = --version ]; then echo "$TEST_PNPM_VERSION"; exit; fi
echo "pnpm $*" >> "$TEST_LOG"
exit "$TEST_PNPM_FAIL"
`)
  put(join(bin, 'curl'), `#!/bin/bash
echo "curl $*" >> "$TEST_LOG"
if [[ "$*" == *api.github.com* ]]; then
  while [ "$#" -gt 0 ] && [ "$1" != -o ]; do shift; done
  if [ "$#" -lt 2 ]; then echo "curl stub: missing -o" >&2; exit 2; fi
  printf '%s' "$TEST_RELEASE" > "$2"
  printf '%s' "$TEST_HTTP_STATUS"
elif [[ "$*" == *nightly.link* ]]; then
  if [ "$TEST_DOWNLOAD_FAIL" = 1 ]; then exit 22; fi
  while [ "$#" -gt 0 ] && [ "$1" != -o ]; do shift; done
  cp "$TEST_ZIP" "$2"
else
  if [ "$TEST_DOWNLOAD_FAIL" = 1 ]; then head -c 20 "$TEST_ARCHIVE"; exit 1; fi
  cat "$TEST_ARCHIVE"
fi
`)
  const tar = spawnSync('which', ['tar'], { encoding: 'utf8' }).stdout.trim()
  put(join(bin, 'tar'), `#!/bin/bash
if [ "$TEST_BACKUP_FAIL" = 1 ] && [ "$1" = cf ]; then exit 1; fi
exec '${tar}' "$@"
`)
  const result = spawnSync('bash', [join(dir, 'update'), ...(options.archive ? ['--archive', archive] : [options.branch ?? 'fix/test'])], {
    encoding: 'utf8',
    env: { ...testEnv, SLEEPYPOD_GITHUB_REPO: options.repositoryOverride ?? '', PATH: `${bin}:${process.env.PATH}`, TMPDIR: join(dir, 'stage'), TEST_LOG: log,
      TEST_START_FAIL: options.startFail ? '1' : '0',
      TEST_WAN_BLOCKED: options.blocked ? '1' : '0', TEST_PNPM_FAIL: options.pnpmFail ? '1' : '0',
      TEST_PNPM_VERSION: options.version ?? '10.34.5', TEST_DOWNLOAD_FAIL: options.downloadFail ? '1' : '0',
      TEST_BACKUP_FAIL: options.backupFail ? '1' : '0', TEST_TEMP_SPACE: options.lowTempSpace ? '100' : '900', TEST_HTTP_STATUS: options.status ?? '200', TEST_ARCHIVE: archive, TEST_ZIP: artifactZip,
      TEST_RELEASE: JSON.stringify({ assets: options.noAsset ? [] : [{ name: 'sleepypod-core.tar.gz', browser_download_url: 'https://example.test/bundle' }] }) },
  })
  return { result, app, dir, repositoryFile, log: existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

describe('sp-update staged deployment', () => {
  it.each(['main', 'fix/test'])('uses the installed fork for %s with no inherited environment', (branch) => {
    const { result, log, repositoryFile } = updater({ repository: 'lucaandrea/sleepypod-core', branch })
    expect(result.status, result.stderr).toBe(0)
    expect(log).toContain(branch === 'main' ? 'api.github.com/repos/lucaandrea/sleepypod-core/releases/latest' : 'nightly.link/lucaandrea/sleepypod-core/workflows/build/fix%2Ftest')
    expect(log).not.toContain('repos/sleepypod/core')
    expect(log).not.toContain('nightly.link/sleepypod/core')
    expect(readFileSync(repositoryFile, 'utf8')).toBe('lucaandrea/sleepypod-core')
  })

  it.each([null, '', 'owner/repo\nother/repo', 'https://github.com/owner/repo', 'owner/repo;touch nope', 'owner/..', `owner/${'x'.repeat(256)}`])('refuses missing or invalid source %j before network or service changes', (repository) => {
    const { result, app, log } = updater({ repository, blocked: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('repository')
    expect(log).toBe('')
    expect(readFileSync(join(app, 'old.txt'), 'utf8')).toBe('old code')
  })

  it('rejects a symlinked repository pin before touching the controller', () => {
    const { result, log } = updater({ repositorySymlink: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('readable regular file')
    expect(log).toBe('')
  })

  it.each(['owner/..', 'owner/repo;echo invalid'])('rejects invalid explicit repository %j without changing the pin', (repositoryOverride) => {
    const { result, repositoryFile, log } = updater({ repositoryOverride })
    expect(result.status).not.toBe(0)
    expect(log).toBe('')
    expect(readFileSync(repositoryFile, 'utf8')).toBe('sleepypod/core\n')
  })

  it('persists an explicit fork outside the replaced app after successful update', () => {
    const { result, log, repositoryFile } = updater({ repositoryOverride: 'lucaandrea/sleepypod-core' })
    expect(result.status, result.stderr).toBe(0)
    expect(log).toContain('nightly.link/lucaandrea/sleepypod-core')
    expect(readFileSync(repositoryFile, 'utf8')).toBe('lucaandrea/sleepypod-core\n')
    expect(statSync(repositoryFile).mode & 0o777).toBe(0o644)
  })

  it.each([false, true])('retains the original source when an explicit update fails (after restart=%s)', (startFail) => {
    const { result, app, repositoryFile } = updater({ repositoryOverride: 'lucaandrea/sleepypod-core', startFail, pnpmFail: !startFail })
    expect(result.status).not.toBe(0)
    expect(readFileSync(repositoryFile, 'utf8')).toBe('sleepypod/core\n')
    expect(readFileSync(join(app, 'old.txt'), 'utf8')).toBe('old code')
  })

  it('removes a newly created source pin when startup fails', () => {
    const { result, repositoryFile } = updater({ repository: null, repositoryOverride: 'lucaandrea/sleepypod-core', startFail: true })
    expect(result.status).not.toBe(0)
    expect(existsSync(repositoryFile)).toBe(false)
  })

  it('allows a local archive without inventing a future download source', () => {
    const { result, repositoryFile, log } = updater({ archive: true, repository: null })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(repositoryFile)).toBe(false)
    expect(log).not.toContain('curl')
  })

  it('checks temporary storage before stopping the service or opening WAN', () => {
    const { result, app, log } = updater({ archive: true, blocked: true, lowTempSpace: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('only 100MB available')
    expect(existsSync(join(app, 'old.txt'))).toBe(true)
    expect(log).toBe('')
  })

  it('cleans a symlinked installation so stale standalone code cannot shadow the new build', () => {
    const { result, app } = updater({ archive: true, symlinkInstall: true })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(app, '.next/standalone/server.js'), 'utf8')).toBe('new standalone server')
    expect(existsSync(join(app, 'old.txt'))).toBe(false)
    expect(readFileSync(join(app, '.next/BUILD_ID'), 'utf8')).toBe('new-build')
  })

  it.each(['404', '403', '500'])('rejects HTTP %s without touching installed files or dependencies', (status) => {
    const { result, app, log } = updater({ status, blocked: true, branch: 'dev' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(status === '404' ? 'No accessible pre-built release' : `HTTP ${status}`)
    expect(readFileSync(join(app, 'old.txt'), 'utf8')).toBe('old code')
    expect(log).not.toContain('pnpm install')
    for (const marker of ['systemctl stop', 'unblock', 'restore', 'systemctl start']) expect(log).toContain(marker)
    expect(log.indexOf('systemctl stop')).toBeLessThan(log.indexOf('unblock'))
    expect(log.indexOf('restore')).toBeLessThan(log.indexOf('systemctl start'))
    expect(log).not.toContain('archive/refs/heads')
  })
  it('rejects a release without an asset', () => {
    const { result, app } = updater({ noAsset: true, branch: 'dev' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Release has no sleepypod-core.tar.gz asset')
    expect(existsSync(join(app, 'old.txt'))).toBe(true)
  })
  it('installs a feature branch from its build.yml artifact via nightly.link', () => {
    const { result, app, log } = updater()
    expect(result.status, result.stderr).toBe(0)
    expect(log).toContain('nightly.link/sleepypod/core/workflows/build/fix%2Ftest/sleepypod-core.zip')
    expect(log).not.toContain('api.github.com')
    expect(readFileSync(join(app, '.next/BUILD_ID'), 'utf8')).toBe('new-build')
  })
  it('rejects a feature branch with no CI build and keeps the installed app', () => {
    const { result, app, log } = updater({ downloadFail: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('No accessible CI build')
    expect(existsSync(join(app, 'old.txt'))).toBe(true)
    expect(log).not.toContain('pnpm install')
  })
  it('rejects interrupted release downloads and keeps the installed app', () => {
    const { result, app, log } = updater({ downloadFail: true, branch: 'dev' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('download/extraction failed')
    expect(existsSync(join(app, 'old.txt'))).toBe(true)
    expect(log).not.toContain('pnpm install')
  })
  it('rejects an incomplete local build before stopping services or opening WAN', () => {
    const { result, app, log } = updater({ archive: true, invalid: true, blocked: true })
    expect(result.stderr).toContain('missing .next/BUILD_ID')
    expect(existsSync(join(app, 'old.txt'))).toBe(true)
    expect(log).toBe('')
  })
  it('reports pnpm mismatch before replacing the app', () => {
    const { result, app, log } = updater({ archive: true, version: '11.0.0' })
    expect(result.stderr).toContain('Expected pnpm@10.34.5')
    expect(existsSync(join(app, 'old.txt'))).toBe(true)
    expect(log).not.toContain('pnpm install')
  })
  it('does not replace files if the backup fails', () => {
    const { result, app, log } = updater({ archive: true, backupFail: true })
    expect(result.status).not.toBe(0)
    expect(existsSync(join(app, 'old.txt'))).toBe(true)
    expect(log).toContain('systemctl start')
    expect(log).not.toContain('pnpm install')
  })
  it.each([true, false])('installs only production deps and preserves Pod env/build metadata (archive=%s)', (archive) => {
    const { result, app, log } = updater({ archive })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(existsSync(join(app, 'old.txt'))).toBe(false)
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe('POD_SECRET=keep')
    expect(readFileSync(join(app, '.git-info'), 'utf8')).toContain('abc1234')
    expect(existsSync(join(app, 'node_modules/foreign.node'))).toBe(false)
    expect(log).toContain('pnpm install --frozen-lockfile --prod')
    expect(log).not.toContain('pnpm build')
    if (archive) expect(log).not.toContain('curl')
  })
  it('restores installed code and restarts after a dependency failure', () => {
    const { result, app, log } = updater({ archive: true, pnpmFail: true, blocked: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('rolling back')
    expect(readFileSync(join(app, 'old.txt'), 'utf8')).toBe('old code')
    expect(log).toContain('restore')
    expect(log).toContain('systemctl start sleepypod.service')
  })
})

function deploy(fail: 'build' | 'transfer' | 'apply' | '' = '', branch = false, repository: 'origin' | 'flag' | 'env' | 'override' | 'https-origin' | 'ssh-origin' = 'origin') {
  const dir = temp()
  const project = join(dir, 'project')
  const bin = join(dir, 'bin')
  const log = join(dir, 'log')
  mkdirSync(join(project, 'scripts'), { recursive: true })
  cpSync(join(repo, 'scripts/deploy'), join(project, 'scripts/deploy'))
  put(join(project, 'scripts/bin/sp-update'), '# updater to upload')
  put(join(project, 'package.json'), '{"packageManager":"pnpm@10.34.5"}')
  put(join(project, '.env'), 'local-secret')
  if (!branch) put(join(project, '.git/config'), 'credential')
  put(join(project, 'node_modules/native.node'), 'wrong-arch')
  put(join(project, 'modules/piezo-processor/.venv/lib/native.so'), 'wrong-python-arch')
  put(join(project, 'modules/piezo-processor/__pycache__/main.pyc'), 'local-bytecode')
  put(join(project, 'modules/piezo-processor/.pytest_cache/state'), 'local-test-cache')
  put(join(project, 'modules/piezo-processor/uv.lock'), 'locked-dependencies')
  put(join(project, 'source.ts'), 'source')
  if (branch || repository.endsWith('-origin')) {
    const git = (args: string[]) => {
      const result = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: testEnv })
      expect(result.status, result.stderr).toBe(0)
    }
    git(['init', '-b', 'main'])
    git(['add', '.'])
    git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture'])
    if (repository === 'origin' || repository.endsWith('-origin')) {
      git(['branch', 'fix/test'])
    }
    else {
      const fork = join(dir, 'fork')
      git(['clone', '--quiet', project, fork])
      git(['-C', fork, 'checkout', '-b', 'fix/test'])
      put(join(fork, 'source.ts'), 'fork-only source')
      git(['-C', fork, 'add', 'source.ts'])
      git(['-C', fork, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fork change'])
      // Exercise real Git fetching, redirecting only the fixture's GitHub URL
      // to a local fork. The fork-only branch is absent from origin.
      git(['config', `url.${fork}.insteadOf`, 'https://github.com/Kovbo/core.git'])
    }
    git(['remote', 'add', 'origin', repository === 'https-origin' ? 'https://github.com/lucaandrea/sleepypod-core.git' : repository === 'ssh-origin' ? 'git@github.com:lucaandrea/sleepypod-core.git' : project])
    put(join(project, 'source.ts'), 'uncommitted local edits')
  }
  put(join(bin, 'pnpm'), `#!/bin/bash
if [ "$1" = --version ]; then echo 10.34.5; exit; fi
echo "pnpm $*" >> "$TEST_LOG"
if [ "$1" = build ]; then
  [ "$DATABASE_URL" = :memory: ] && [ "$BIOMETRICS_DATABASE_URL" = :memory: ] || exit 91
  [ "$TEST_FAIL" != build ] || exit 1
  mkdir -p .next/standalone/node_modules .next/cache
  echo build > .next/BUILD_ID
  echo '{}' > .next/required-server-files.json
  echo standalone > .next/standalone/server.js
  echo '{"commitHash":"new-build"}' > .git-info
  echo native > .next/standalone/node_modules/native.node
  echo cache > .next/cache/item
fi
`)
  put(join(bin, 'ssh'), `#!/bin/bash
cmd="\${!#}"
echo "ssh $cmd" >> "$TEST_LOG"
case "$cmd" in
  'export PATH=/usr/local/bin:'*) exit 0 ;;
  *mktemp*) mkdir -p "$TEST_REMOTE"; echo "$TEST_REMOTE" ;;
  'cat > '*)
    bash -c "$cmd"
    if [[ "$cmd" == *tar.gz* ]]; then
      cp "$TEST_REMOTE/sleepypod-core.tar.gz" "$TEST_CAPTURE"
      [ "$TEST_FAIL" != transfer ] || exit 1
    fi ;;
  'bash '*|'env SLEEPYPOD_GITHUB_REPO='*) [ "$TEST_FAIL" != apply ] ;;
  'rm -rf '*) bash -c "$cmd" ;;
  *) exit 90 ;;
esac
`)
  const result = spawnSync('bash', [join(project, 'scripts/deploy'), 'pod.local', ...(branch ? ['fix/test'] : []), ...(['flag', 'override'].includes(repository) ? ['--repo', 'Kovbo/core'] : [])], { encoding: 'utf8',
    env: { ...testEnv, SLEEPYPOD_GITHUB_REPO: repository === 'env' ? 'Kovbo/core' : repository === 'override' ? 'unused/wrong-repo' : '', PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_FAIL: fail,
      TEST_REMOTE: join(dir, 'sleepypod-deploy.abcdef'), TEST_CAPTURE: join(dir, 'captured.tar.gz') },
  })
  return { result, log: existsSync(log) ? readFileSync(log, 'utf8') : '', dir, project }
}

describe('local deploy', () => {
  it.each(['https-origin', 'ssh-origin'] as const)('carries the checkout fork from %s into the updater', (repository) => {
    const { result, log } = deploy('', false, repository)
    expect(result.status, result.stderr).toBe(0)
    expect(log).toContain('env SLEEPYPOD_GITHUB_REPO=\'lucaandrea/sleepypod-core\' bash')
  })
  it.each(['flag', 'env', 'override'] as const)('fetches a fork-only branch using %s without changing origin or local edits', (repository) => {
    const { result, project, dir, log } = deploy('', true, repository)
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(project, 'source.ts'), 'utf8')).toBe('uncommitted local edits')
    const git = (args: string[]) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: testEnv })
    expect(git(['remote', 'get-url', 'origin']).stdout.trim()).toBe(project)
    expect(git(['branch', '--show-current']).stdout.trim()).toBe('main')
    expect(git(['show-ref', '--verify', 'refs/heads/fix/test']).status).not.toBe(0)
    expect(git(['worktree', 'list', '--porcelain']).stdout.match(/^worktree /gm)).toHaveLength(1)
    const archived = spawnSync('tar', ['xOf', join(dir, 'captured.tar.gz'), './source.ts'], { encoding: 'utf8' })
    expect(archived.stdout).toBe('fork-only source')
    expect(log).toContain('env SLEEPYPOD_GITHUB_REPO=\'Kovbo/core\' bash')
  })
  it.each([
    ['--repo'],
    ['--repo', 'Kovbo/core', 'pod.local'],
    ['--repo', 'https://github.com/Kovbo/core', 'pod.local', 'fix/test'],
  ])('rejects incomplete or invalid repository arguments before SSH: %j', (...args) => {
    const dir = temp()
    put(join(dir, 'ssh'), '#!/bin/bash\necho UNEXPECTED_SSH >&2\nexit 99\n')
    const result = spawnSync('bash', [join(repo, 'scripts/deploy'), ...args], {
      encoding: 'utf8', env: { ...testEnv, SLEEPYPOD_GITHUB_REPO: '', PATH: `${dir}:${process.env.PATH}` },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('OWNER/REPO')
    expect(result.stderr).not.toContain('UNEXPECTED_SSH')
  })

  it('builds an origin branch in isolation and preserves the current checkout and edits', () => {
    const { result, project, dir } = deploy('', true)
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(project, 'source.ts'), 'utf8')).toBe('uncommitted local edits')
    const git = (args: string[]) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: testEnv }).stdout
    expect(git(['branch', '--show-current']).trim()).toBe('main')
    expect(git(['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
    const archived = spawnSync('tar', ['xOf', join(dir, 'captured.tar.gz'), './source.ts'], { encoding: 'utf8' })
    expect(archived.stdout).toBe('source')
  })

  it('stages an archive without secrets/native modules before applying with the bundled updater', () => {
    const { result, log, dir } = deploy()
    expect(result.status, result.stderr).toBe(0)
    const archive = spawnSync('tar', ['tzf', join(dir, 'captured.tar.gz')], { encoding: 'utf8' }).stdout
    expect(archive).toContain('./.next/BUILD_ID')
    expect(archive).toContain('./.next/standalone/server.js')
    expect(archive).toContain('./.next/standalone/.git-info')
    expect(archive).toContain('./source.ts')
    expect(archive).toContain('./modules/piezo-processor/uv.lock')
    for (const excluded of ['.env', '.git/', 'node_modules', '.next/cache', '.venv', '__pycache__', '.pytest_cache']) expect(archive).not.toContain(excluded)
    expect(log).toContain('export PATH=/usr/local/bin:$PATH; test -d /home/dac/sleepypod-core')
    expect(log).toContain('--archive')
    for (const marker of ['cat >', 'ssh bash']) expect(log).toContain(marker)
    expect(log.indexOf('cat >')).toBeLessThan(log.indexOf('ssh bash'))
    expect(log).not.toContain('find /home/dac')
  })
  it.each(['build', 'transfer'] as const)('does not invoke the updater on %s failure', (fail) => {
    const { result, log } = deploy(fail)
    expect(result.status).not.toBe(0)
    expect(log).not.toContain('ssh bash')
  })
  it('propagates update failure without printing success', () => {
    const { result } = deploy('apply')
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('Deploy complete')
  })
})
