// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string
let bin: string
let install: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-diagnostics-'))
  bin = join(root, 'bin')
  install = join(root, 'install')
  mkdirSync(bin)
  mkdirSync(install)
  writeFileSync(join(root, 'rat_version'), 'f76374f38f9ffed57b320b1b079c6fcf00242bf5\n')
  writeFileSync(join(root, 'build_time_epoch'), '1741635384\n')
  writeFileSync(join(root, 'frank.sh'), '# old firmware\n')
  writeFileSync(join(install, '.git-info'), JSON.stringify({ commitHash: 'abc123', branch: 'main', buildDate: '2026-10-05' }))
  writeFileSync(join(install, '.env'), 'PORT=3333\nAPI_TOKEN=secret-for-redaction-test\n')
  for (const script of ['sp-info', 'sp-logs', 'sp-status', 'sp-bundle-logs']) {
    let source = readFileSync(resolve('scripts/bin', script), 'utf8')
    for (const file of ['rat_version', 'build_time_epoch']) source = source.replaceAll(`/etc/${file}`, join(root, file))
    source = source.replaceAll('/opt/eight/bin/frank.sh', join(root, 'frank.sh'))
    writeFileSync(join(bin, script), source, { mode: 0o755 })
  }
  writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf "%s" "$MOCK_STATUS"\n', { mode: 0o755 })
  writeFileSync(join(bin, 'journalctl'), '#!/bin/bash\nprintf "<%s>" "$@"\nprintf "\\n"\n', { mode: 0o755 })
  for (const command of ['systemctl', 'iptables-save', 'ip', 'ss', 'pgrep', 'mountpoint', 'pnpm', 'uv']) {
    writeFileSync(join(bin, command), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
  }
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_DIR: install, TMPDIR: root, MOCK_STATUS: '{"sensorLabel":"20600-0003-J55-PRIVATE-SERIAL"}' }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(script: string, args: string[] = []) {
  return spawnSync('/bin/bash', [join(bin, script), ...args], { encoding: 'utf8', env, timeout: 20_000 })
}

it('prints sensor/cover revision, raw firmware revision and app build without device serials or env secrets', () => {
  const result = run('sp-info')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('sensor/cover: Pod 5 (J55)')
  expect(result.stdout).toContain('hub model:   unknown (unverified)')
  expect(result.stdout).toContain('f76374f38f9ffed57b320b1b079c6fcf00242bf5')
  expect(result.stdout).toContain('abc123 (main)')
  expect(result.stdout).not.toContain('PRIVATE-SERIAL')
  expect(result.stdout).not.toContain('secret-for-redaction-test')
})

it.each(['', 'not json', '{"sensorLabel":"unknown"}'])('keeps firmware context when hardware status is unavailable: %j', (status) => {
  env.MOCK_STATUS = status
  const result = run('sp-info')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('sensor/cover: unknown')
  expect(result.stdout).toContain('f76374f38')
})

it('follows app logs by default with support context', () => {
  const result = run('sp-logs')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('sensor/cover: Pod 5 (J55)')
  expect(result.stdout).toContain('hub model:   unknown (unverified)')
  expect(result.stdout).toContain('<-u><sleepypod.service><-f><--no-pager>')
})

const since = '2026-10-05 19:50:00 UTC'
const until = '2026-10-05 20:05:00 UTC'
it('prints combined historical logs with literal time arguments and no follow or boot filter', () => {
  const result = run('sp-logs', ['--firmware', '--since', since, '--until', until, '--no-pager'])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain(`<--since><${since}><--until><${until}>`)
  expect(result.stdout).toContain('<-u><frank.service>')
  expect(result.stdout).not.toContain('<-f>')
  expect(result.stdout).not.toContain('<-b>')
})

it.each(['sp-logs', 'sp-bundle-logs'])('%s rejects missing time values before collecting anything', (script) => {
  expect(run(script, ['--since']).status).toBe(2)
  expect(run(script, ['--until', '--no-redact']).status).toBe(2)
})

it.each([false, true])('bundles firmware context and combined timeline (explicit window: %s)', (window) => {
  const result = run('sp-bundle-logs', window ? ['--since', since, '--until', until] : [])
  expect(result.status, result.stderr).toBe(0)
  const archive = result.stdout.match(/Bundle written: (.+\.tar\.gz) /)?.[1]
  if (!archive) throw new Error(`No bundle produced: ${result.stdout}`)
  const entry = (name: string) => execFileSync('tar', ['-xOf', archive, `./${name}`], { encoding: 'utf8' })
  const timeline = entry('journals/hardware-timeline.log')
  expect(timeline).toContain('<-u><frank.service><-u><sleepypod.service>')
  expect(entry('journals/frank.service.log')).toContain('<-u><frank.service>')
  expect(entry('versions/pod-firmware.txt')).toContain('Pod 5 (J55)')
  expect(entry('config/.env')).toContain('API_TOKEN=<redacted>')
  expect(entry('config/.env')).not.toContain('secret-for-redaction-test')
  if (window) {
    expect(timeline).toContain(`<--since><${since}><--until><${until}>`)
    expect(timeline).not.toContain('<-b>')
    expect(entry('journals/frank.service.log')).toContain(`<--since><${since}>`)
  }
  else expect(timeline).toContain('<-b>')
})

it.each(['--since', '--until'])('rejects invalid %s timestamps without producing a bundle', (option) => {
  writeFileSync(join(bin, 'journalctl'), `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = "not-a-date" ]; then
    echo "Failed to parse timestamp: not-a-date" >&2
    exit 1
  fi
done
`, { mode: 0o755 })
  const result = run('sp-bundle-logs', [option, 'not-a-date'])
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('Failed to parse timestamp')
  expect(result.stdout).not.toContain('Bundle written:')
  expect(readdirSync(root).filter(name => name.startsWith('sleepypod-bundle'))).toEqual([])
})
