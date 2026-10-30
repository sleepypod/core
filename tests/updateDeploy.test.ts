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
function updater(options: { invalid?: boolean, noAsset?: boolean, archive?: boolean, status?: string, blocked?: boolean, pnpmFail?: boolean, version?: string, downloadFail?: boolean, backupFail?: boolean, symlinkInstall?: boolean, lowTempSpace?: boolean, branch?: string, dnsFail?: boolean, realTelemetry?: boolean, controlLog?: boolean, stockUnits?: boolean, firmwareAllow?: boolean } = {}) {
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
  // The real helper; SLEEPYPOD_ROOT below keeps its writes inside the fixture.
  put(join(bundle, 'scripts/lib/internet-choice-helpers'), readFileSync(join(repo, 'scripts/lib/internet-choice-helpers'), 'utf8'))
  put(join(bundle, 'scripts/internet-control'), '#!/bin/bash\necho control\n')
  // The real helper edits /etc/hosts, masks units and restarts NetworkManager
  // through scripts/internet-control. These stubs only record which tree ran.
  for (const [tree, label] of [[app, 'old'], [bundle, 'new']] as const) {
    put(join(tree, 'scripts/lib/telemetry-helpers'), `block_stock_telemetry() { echo "telemetry ${label}" >> "$TEST_LOG"; }
apply_dns_blackhole() { echo "dns ${label}" >> "$TEST_LOG"; [ "$TEST_DNS_FAIL" = 1 ] && return 1; return 0; }
`)
  }
  if (options.realTelemetry) {
    // v3.5.0–v3.6.1 installed trees run hosts-block before downloading, which
    // (re)writes the 0.0.0.0 block. The new tree's real helpers must remove it.
    put(join(app, 'scripts/lib/telemetry-helpers'), `block_stock_telemetry() {
  echo "telemetry old" >> "$TEST_LOG"
  printf '\\n# BEGIN sleepypod-telemetry-block\\n0.0.0.0 raw-api-upload.8slp.net\\n# END sleepypod-telemetry-block\\n' >> "$INTERNET_CONTROL_ROOT/etc/hosts"
}
`)
    for (const file of ['scripts/lib/telemetry-helpers', 'scripts/internet-control']) {
      put(join(bundle, file), readFileSync(join(repo, file), 'utf8'))
    }
    put(join(bundle, 'scripts/lib/maintenance-helpers'), readFileSync(join(repo, 'scripts/lib/maintenance-helpers'), 'utf8').replaceAll('/etc/systemd/system', join(dir, 'systemd')))
    for (const unit of ['sleepypod-maintenance.service', 'sleepypod-maintenance.timer']) put(join(bundle, 'scripts/systemd', unit), '')
    mkdirSync(join(dir, 'systemd'), { recursive: true })
    put(join(dir, 'root/etc/hosts'), '127.0.0.1 localhost\n')
  }
  if (options.controlLog) {
    // Both trees run the real helpers; internet-control only records each call.
    for (const [tree, label] of [[app, 'old'], [bundle, 'new']] as const) {
      put(join(tree, 'scripts/lib/telemetry-helpers'), readFileSync(join(repo, 'scripts/lib/telemetry-helpers'), 'utf8'))
      put(join(tree, 'scripts/internet-control'), `#!/bin/bash\necho "control ${label} $1" >> "$TEST_LOG"\n`)
    }
  }
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
    ['/etc/systemd/system', join(dir, 'systemd')],
  ]
  for (const [from, to] of rewrites) {
    expect(script).toContain(from)
    script = script.replaceAll(from, to)
  }
  // Telemetry blocking reaches /etc/hosts and NetworkManager only through
  // $INSTALL_DIR's scripts (rewritten above to the fixture tree, whose
  // helpers are stubs); sp-update itself must name neither path.
  for (const systemPath of ['/etc/hosts', '/etc/NetworkManager']) {
    expect(script).not.toContain(systemPath)
  }
  expect(script).not.toMatch(/(?<!\$tree\/|\$INSTALL_DIR\/)scripts\/internet-control/)
  put(join(dir, 'update'), script)
  // Logs only; with stockUnits every unit the helpers ask about reports enabled.
  put(join(bin, 'systemctl'), '#!/bin/bash\necho "systemctl $*" >> "$TEST_LOG"\n[ "$1" = is-enabled ] && [ "$TEST_STOCK_UNITS" = 1 ] && echo enabled\nexit 0\n')
  if (options.firmwareAllow) put(join(dir, 'root/etc/sleepypod/firmware-updates'), 'allow\n')
  put(join(bin, 'df'), `#!/bin/bash
available=900
if [ "$2" = "$TMPDIR" ]; then available=$TEST_TEMP_SPACE; fi
echo 'Filesystem Size Used Available Use% Mounted'
echo "fixture 1000 100 $available 10% /"
`)
  put(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n')
  put(join(bin, 'chown'), '#!/bin/bash\necho "chown $*" >> "$TEST_LOG"\n')
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
    env: { ...testEnv, PATH: `${bin}:${process.env.PATH}`, TMPDIR: join(dir, 'stage'), TEST_LOG: log, SLEEPYPOD_ROOT: join(dir, 'root'),
      INTERNET_CONTROL_ROOT: join(dir, 'root'), VECTOR_DATA_DIR: join(dir, 'vector'),
      TEST_WAN_BLOCKED: options.blocked ? '1' : '0', TEST_PNPM_FAIL: options.pnpmFail ? '1' : '0',
      TEST_PNPM_VERSION: options.version ?? '10.34.5', TEST_DOWNLOAD_FAIL: options.downloadFail ? '1' : '0',
      TEST_BACKUP_FAIL: options.backupFail ? '1' : '0', TEST_STOCK_UNITS: options.stockUnits ? '1' : '0', TEST_DNS_FAIL: options.dnsFail ? '1' : '0', TEST_TEMP_SPACE: options.lowTempSpace ? '100' : '900', TEST_HTTP_STATUS: options.status ?? '200', TEST_ARCHIVE: archive, TEST_ZIP: artifactZip,
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
    const { result, app, log } = updater({ status, blocked: true, branch: 'dev' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(status === '404' ? 'No accessible pre-built release' : `HTTP ${status}`)
    expect(readFileSync(join(app, 'old.txt'), 'utf8')).toBe('old code')
    expect(log).not.toContain('pnpm install')
    for (const marker of ['telemetry old', 'systemctl stop', 'unblock', 'restore', 'systemctl start']) expect(log).toContain(marker)
    expect(log.indexOf('telemetry old')).toBeLessThan(log.indexOf('unblock'))
    expect(log.indexOf('systemctl stop')).toBeLessThan(log.indexOf('unblock'))
    expect(log.indexOf('restore')).toBeLessThan(log.indexOf('systemctl start'))
    expect(log).not.toContain('archive/refs/heads')
  })
  it('blocks telemetry from the installed tree before opening WAN, then again from the new code', () => {
    const { result, log } = updater({ blocked: true, branch: 'dev' })
    expect(result.status, result.stderr).toBe(0)
    const lines = log.split('\n')
    expect(lines.indexOf('telemetry old')).toBeGreaterThanOrEqual(0)
    expect(lines.indexOf('telemetry old')).toBeLessThan(lines.indexOf('unblock'))
    expect(lines.indexOf('telemetry new')).toBeGreaterThan(lines.indexOf('unblock'))
    expect(lines.indexOf('telemetry new')).toBeLessThan(lines.findIndex(line => line.startsWith('pnpm install')))
  })

  it('reapplies the new tree\'s DNS config after every download, before re-blocking WAN and starting', () => {
    const { result, log } = updater({ blocked: true, branch: 'dev' })
    expect(result.status, result.stderr).toBe(0)
    const lines = log.split('\n')
    const dns = lines.indexOf('dns new')
    expect(lines.filter(line => line.startsWith('dns '))).toEqual(['dns new'])
    expect(dns).toBeGreaterThan(lines.findLastIndex(line => line.startsWith('curl ') || line.startsWith('pnpm install')))
    expect(dns).toBeLessThan(lines.indexOf('restore'))
    expect(dns).toBeLessThan(lines.indexOf('systemctl start sleepypod.service'))
  })

  it('finishes the update when the DNS layer fails', () => {
    const { result, log } = updater({ archive: true, dnsFail: true })
    expect(result.status, result.stderr).toBe(0)
    expect(log).toContain('dns new')
    expect(log).toContain('systemctl start sleepypod.service')
  })

  it('blocks telemetry whatever the WAN state', () => {
    const { result, log } = updater({ archive: true })
    expect(result.status, result.stderr).toBe(0)
    expect(log).not.toContain('unblock')
    expect(log.split('\n').filter(line => line.startsWith('telemetry '))).toEqual(['telemetry old', 'telemetry new'])
  })

  it('removes the 0.0.0.0 hosts block an older installed tree re-adds before downloading, in the same update', () => {
    const { result, dir, log } = updater({ archive: true, realTelemetry: true })
    expect(result.status, result.stderr).toBe(0)
    const lines = log.split('\n')
    const added = lines.indexOf('telemetry old')
    // The new tree's block_stock_telemetry (its first systemctl call) and the maintenance hook run after it.
    const newPass = lines.indexOf('systemctl is-enabled vector.service')
    expect(added).toBeGreaterThanOrEqual(0)
    expect(newPass).toBeGreaterThan(added)
    expect(lines.indexOf('systemctl enable --now sleepypod-maintenance.timer')).toBeGreaterThan(added)
    expect(newPass).toBeLessThan(lines.indexOf('systemctl start sleepypod.service'))
    const hosts = join(dir, 'root/etc/hosts')
    expect(readFileSync(`${hosts}.bak.sleepypod`, 'utf8')).toContain('0.0.0.0 raw-api-upload.8slp.net')
    expect(readFileSync(hosts, 'utf8')).toBe('127.0.0.1 localhost\n')
    expect(result.stdout).toContain('Removed Eight Sleep domains from /etc/hosts')
  })

  it('removes the hosts block, then turns on dns-block, before WAN opens; reapplies dns-block after every download', () => {
    const { result, log } = updater({ blocked: true, branch: 'dev', controlLog: true })
    expect(result.status, result.stderr).toBe(0)
    const lines = log.split('\n')
    const at = (line: string) => lines.indexOf(line)
    const wanOpen = at('unblock')
    const firstDownload = lines.findIndex(line => line.startsWith('curl '))
    const lastDownload = lines.findLastIndex(line => line.startsWith('curl ') || line.startsWith('pnpm install'))
    const lastDns = lines.lastIndexOf('control new dns-block')
    expect(at('control old hosts-unblock')).toBeGreaterThanOrEqual(0)
    expect(at('control old dns-block')).toBeGreaterThan(at('control old hosts-unblock'))
    expect(wanOpen).toBeGreaterThan(at('control old dns-block'))
    expect(firstDownload).toBeGreaterThan(wanOpen)
    expect(at('control new hosts-unblock')).toBeGreaterThan(wanOpen)
    expect(at('control new dns-block')).toBeGreaterThan(at('control new hosts-unblock'))
    expect(lastDns).toBeGreaterThan(lastDownload)
    expect(lastDns).toBeLessThan(at('restore'))
    expect(lastDns).toBeLessThan(at('systemctl start sleepypod.service'))
  })

  it.each([false, true])('masks the stock updater from the new tree in one update unless the owner opted in (allow: %s)', (firmwareAllow) => {
    const { result, log } = updater({ archive: true, realTelemetry: true, stockUnits: true, firmwareAllow })
    expect(result.status, result.stderr).toBe(0)
    const lines = log.split('\n')
    const start = lines.indexOf('systemctl start sleepypod.service')
    const mask = (unit: string) => lines.indexOf(`systemctl mask ${unit}`)
    expect(mask('eight-kernel.service')).toBeGreaterThanOrEqual(0)
    expect(mask('eight-kernel.service')).toBeLessThan(start)
    for (const unit of ['swupdate.socket', 'swupdate.service', 'swupdate-progress.service', 'defibrillator.service']) {
      expect(mask(unit) >= 0).toBe(!firmwareAllow)
    }
    if (!firmwareAllow) expect(mask('swupdate.socket')).toBeLessThan(mask('swupdate.service'))
    expect(log).not.toMatch(/swupdate-usb|frankenfirmware|capybara|burrow/)
  })

  it('installs the root ExecStartPre that re-applies a block saved in Settings, before starting', () => {
    const { result, dir, log } = updater({ archive: true })
    expect(result.status, result.stderr).toBe(0)
    const dropIn = readFileSync(join(dir, 'root/etc/systemd/system/sleepypod.service.d/iptables-saved-choice.conf'), 'utf8')
    expect(dropIn).toBe('[Service]\nExecStartPre=+/bin/sh -c \'PATH=/usr/sbin:/sbin:/usr/bin:/bin /usr/local/bin/sp-internet-control restore; true\'\n')
    const copy = join(dir, 'root/usr/local/bin/sp-internet-control')
    expect(readFileSync(copy, 'utf8')).toBe('#!/bin/bash\necho control\n')
    expect(log).toContain(`chown root:root ${copy}`)
    expect(log.indexOf('systemctl daemon-reload')).toBeLessThan(log.indexOf('systemctl start sleepypod.service'))
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
    // Only the installed tree's telemetry blocking ran: no stop, no WAN opening.
    expect(log).toBe('telemetry old\n')
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
  put(join(project, 'modules/piezo-processor/.venv/lib/native.so'), 'wrong-python-arch')
  put(join(project, 'modules/piezo-processor/__pycache__/main.pyc'), 'local-bytecode')
  put(join(project, 'modules/piezo-processor/.pytest_cache/state'), 'local-test-cache')
  put(join(project, 'modules/piezo-processor/uv.lock'), 'locked-dependencies')
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
