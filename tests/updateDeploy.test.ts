import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, symlinkSync } from 'node:fs'
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
function updater(options: { invalid?: boolean, noAsset?: boolean, archive?: boolean, status?: string, blocked?: boolean, pnpmFail?: boolean, version?: string, downloadFail?: boolean, backupFail?: boolean, symlinkInstall?: boolean, lowTempSpace?: boolean } = {}) {
  const dir = temp()
  const app = join(dir, 'app')
  const bundle = join(dir, 'bundle')
  const bin = join(dir, 'bin')
  const log = join(dir, 'log')
  mkdirSync(join(dir, 'data'))
  mkdirSync(join(dir, 'stage'))
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
  let script = readFileSync(join(repo, 'scripts/bin/sp-update'), 'utf8')
  const rewrites: [string, string][] = [
    ['export PATH="/usr/local/bin:$PATH"', ''],
    ['/home/dac/sleepypod-core', installPath],
    ['/persistent/sleepypod-data', join(dir, 'data')],
    ['/etc/sleepypod/data-dir', join(dir, 'data-dir')],
    ['/etc/systemd/system', join(dir, 'systemd')],
    ['/etc/hosts', join(dir, 'hosts')],
  ]
  for (const [from, to] of rewrites) {
    expect(script).toContain(from)
    script = script.replaceAll(from, to)
  }
  put(join(dir, 'hosts'), '# BEGIN sleepypod-telemetry-block')
  put(join(dir, 'update'), script)
  put(join(bin, 'systemctl'), '#!/bin/bash\necho "systemctl $*" >> "$TEST_LOG"\n')
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
  const result = spawnSync('bash', [join(dir, 'update'), ...(options.archive ? ['--archive', archive] : ['fix/test'])], {
    encoding: 'utf8',
    env: { ...testEnv, PATH: `${bin}:${process.env.PATH}`, TMPDIR: join(dir, 'stage'), TEST_LOG: log,
      TEST_WAN_BLOCKED: options.blocked ? '1' : '0', TEST_PNPM_FAIL: options.pnpmFail ? '1' : '0',
      TEST_PNPM_VERSION: options.version ?? '10.34.5', TEST_DOWNLOAD_FAIL: options.downloadFail ? '1' : '0',
      TEST_BACKUP_FAIL: options.backupFail ? '1' : '0', TEST_TEMP_SPACE: options.lowTempSpace ? '100' : '900', TEST_HTTP_STATUS: options.status ?? '200', TEST_ARCHIVE: archive,
      TEST_RELEASE: JSON.stringify({ assets: options.noAsset ? [] : [{ name: 'sleepypod-core.tar.gz', browser_download_url: 'https://example.test/bundle' }] }) },
  })
  return { result, app, dir, log: existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

describe('sp-update staged deployment', () => {
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
    const { result, app, log } = updater({ status, blocked: true })
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
    const { result, app } = updater({ noAsset: true })
    expect(result.stderr).toContain('Release has no sleepypod-core.tar.gz asset')
    expect(existsSync(join(app, 'old.txt'))).toBe(true)
  })
  it('rejects interrupted downloads and keeps the installed app', () => {
    const { result, app, log } = updater({ downloadFail: true })
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

function deploy(fail: 'build' | 'transfer' | 'apply' | '' = '', branch = false, repository: 'origin' | 'flag' | 'env' | 'override' = 'origin') {
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
  put(join(project, 'source.ts'), 'source')
  if (branch) {
    const git = (args: string[]) => {
      const result = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: testEnv })
      expect(result.status, result.stderr).toBe(0)
    }
    git(['init', '-b', 'main'])
    git(['add', '.'])
    git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture'])
    if (repository === 'origin') {
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
    git(['remote', 'add', 'origin', project])
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
  'bash '*) [ "$TEST_FAIL" != apply ] ;;
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
  it.each(['flag', 'env', 'override'] as const)('fetches a fork-only branch using %s without changing origin or local edits', (repository) => {
    const { result, project, dir } = deploy('', true, repository)
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(project, 'source.ts'), 'utf8')).toBe('uncommitted local edits')
    const git = (args: string[]) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: testEnv })
    expect(git(['remote', 'get-url', 'origin']).stdout.trim()).toBe(project)
    expect(git(['branch', '--show-current']).stdout.trim()).toBe('main')
    expect(git(['show-ref', '--verify', 'refs/heads/fix/test']).status).not.toBe(0)
    expect(git(['worktree', 'list', '--porcelain']).stdout.match(/^worktree /gm)).toHaveLength(1)
    const archived = spawnSync('tar', ['xOf', join(dir, 'captured.tar.gz'), './source.ts'], { encoding: 'utf8' })
    expect(archived.stdout).toBe('fork-only source')
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
    for (const excluded of ['.env', '.git/', 'node_modules', '.next/cache']) expect(archive).not.toContain(excluded)
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
