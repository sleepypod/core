// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string
let servers: Server[]
const persistent = '/persistent/deviceinfo/dac.sock'
const legacy = '/deviceinfo/dac.sock'

beforeEach(() => {
  // Short paths also fit macOS's Unix socket pathname limit.
  root = mkdtempSync('/tmp/sp-detect-')
  servers = []
  for (const dir of ['install', 'etc', 'usr/lib', 'opt/eight/bin', 'persistent/deviceinfo', 'deviceinfo']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  for (const script of ['detect', 'capabilities']) {
    // Sandbox filesystem observations while executing the actual shell logic.
    const source = readFileSync(resolve('scripts/pod', script), 'utf8')
      .replace(/\/(?:persistent\/deviceinfo|deviceinfo|etc|usr\/lib|opt\/eight\/bin)(?=\/)/g, path => root + path)
    writeFileSync(join(root, script), source)
  }
})
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((done) => {
    server.close(() => done())
  })))
  rmSync(root, { recursive: true, force: true })
})

async function socket(path: string) {
  const server = createServer()
  servers.push(server)
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(root + path, done)
  })
}
function config(path: string) {
  writeFileSync(join(root, 'install/.env'), `DAC_SOCK_PATH=${root}${path}\n`)
}
function firmware(path: string) {
  writeFileSync(join(root, 'opt/eight/bin/frank.sh'), `DAC_SOCKET=${root}${path} frank\n`)
}
function run(extra = '') {
  const result = spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', `source "$FIXTURE/detect"; printf 'path=%s\nsource=%s\ngen=%s\n' "$DAC_SOCK_PATH" "$DAC_SOCK_SOURCE" "$POD_GEN"; ${extra}`], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, FIXTURE: root, INSTALL_DIR: join(root, 'install'), DATA_DIR: join(root, 'data'), POD_GEN: '5' },
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('gen=unknown')
  return result
}

it.each([persistent, legacy])('discovers %s without inferring hardware (including hub3/pod4 on persistent)', async (path) => {
  await socket(path)
  const result = run()
  expect(result.stdout).toContain(`path=${root}${path}`)
  expect(result.stdout).toContain('source=existing socket file')
  expect(result.stderr).not.toContain('Pod 5')
})
it('explicitly reports the unverified fallback and communication risk', () => {
  const result = run()
  expect(result.stdout).toContain(`path=${root}${persistent}`)
  expect(result.stdout).toContain('source=fallback (unverified)')
  expect(result.stderr).toContain('DAC communication will fail')
  expect(result.stderr).not.toContain('Pod 5')
})
it.each([persistent, legacy])('preserves supported configuration %s over other discovery evidence', async (path) => {
  config(path)
  await socket(path)
  firmware(path === persistent ? legacy : persistent)
  expect(run().stdout).toContain(`path=${root}${path}\nsource=configuration`)
})
it.each([persistent, legacy])('preserves firmware-confirmed configuration %s before a socket exists', (path) => {
  config(path)
  firmware(path)
  expect(run().stdout).toContain(`path=${root}${path}\nsource=configuration`)
})
it('replaces stale configuration with firmware discovery', () => {
  config(persistent)
  firmware(legacy)
  const result = run()
  expect(result.stdout).toContain(`path=${root}${legacy}\nsource=firmware`)
  expect(result.stderr).toContain('Ignoring stale DAC_SOCK_PATH')
})
it('replaces stale configuration with an existing socket', async () => {
  config(legacy)
  await socket(persistent)
  expect(run().stdout).toContain(`path=${root}${persistent}\nsource=existing socket file`)
})
it('marks stale configuration without other evidence as fallback', () => {
  config(legacy)
  const result = run()
  expect(result.stderr).toContain('Ignoring stale DAC_SOCK_PATH')
  expect(result.stdout).toContain('source=fallback (unverified)')
})
it.each([persistent, legacy])('discovers firmware path %s without a socket', (path) => {
  firmware(path)
  expect(run().stdout).toContain(`path=${root}${path}\nsource=firmware`)
})
it('rejects unsupported configuration and firmware paths', () => {
  config('/other/dac.sock')
  firmware('/other/dac.sock')
  const result = run()
  expect(result.stderr).toContain('unsupported DAC_SOCK_PATH from .env')
  expect(result.stderr).toContain('unsupported DAC_SOCK_PATH from frank.sh')
  expect(result.stdout).toContain('source=fallback (unverified)')
})

const probes = `
# Simulate an in-range interpreter whose stdlib is incomplete, and apt.
command() {
  if [ "$1" = -v ]; then
    case "$2" in python3|apt-get) echo "/mock/$2"; return 0;; *) return 1;; esac
  fi
  builtin command "$@"
}
python3() {
  case "$2" in
    *'print('* ) echo 3.9.9;;
    *'sys.exit('* ) return 0;;
    *) return 1;;
  esac
}
source "$FIXTURE/capabilities"
print_pod_capabilities
`
it.each([persistent, legacy])('probes Python, package manager and OS independently of %s', (path) => {
  firmware(path)
  writeFileSync(join(root, 'etc/os-release'), 'ID=poky\nPRETTY_NAME="Eight Layer 4.0.2"\n')
  const result = run(probes)
  expect(result.stdout).toContain('Hub / cover unknown (unverified)')
  expect(result.stdout).toContain('OS:                   Eight Layer 4.0.2')
  expect(result.stdout).toContain('Package manager:      apt')
  expect(result.stdout).toContain('3.9.9 (in biometrics range: true, stdlib intact: false)')
  expect(result.stdout).toContain('ensurepip:            false')
})
it('reports unknown OS without metadata despite apt and an inherited generation', () => {
  expect(run(probes).stdout).toContain('OS:                   unknown')
})
it('uses vendor OS metadata when /etc/os-release is absent', () => {
  writeFileSync(join(root, 'usr/lib/os-release'), 'ID=debian\n')
  expect(run(probes).stdout).toContain('OS:                   debian')
})
it('capabilities can be sourced by the updater without detection', () => {
  const result = spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', probes + 'test "${PRETTY_NAME-unset}" = unset'], {
    encoding: 'utf8', env: { ...process.env, FIXTURE: root, POD_GEN: '5', DAC_SOCK_PATH: persistent },
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Hub / cover unknown (unverified)')
  expect(result.stdout).toContain('stdlib intact: false')
})

it('handles an existing .env without a socket setting under strict shell options', () => {
  writeFileSync(join(root, 'install/.env'), 'PORT=3000\n')
  expect(run().stdout).toContain('source=fallback (unverified)')
})
it('prefers /etc OS metadata over vendor metadata without leaking variables', () => {
  writeFileSync(join(root, 'etc/os-release'), 'PRETTY_NAME="Eight Layer"\n')
  writeFileSync(join(root, 'usr/lib/os-release'), 'ID=debian\n')
  expect(run(probes + 'test "${PRETTY_NAME-unset}" = unset').stdout).toContain('OS:                   Eight Layer')
})
