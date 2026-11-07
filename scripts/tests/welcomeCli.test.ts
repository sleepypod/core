// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const STATUS = JSON.stringify({
  leftSide: { currentTemperature: 74.4, targetTemperature: 68, currentLevel: -20, targetLevel: -20, heatingDuration: 600 },
  rightSide: { currentTemperature: 71, targetTemperature: 80, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  waterLevel: 'ok',
  isPriming: false,
  podVersion: 'J00',
  sensorLabel: '20600-0003-J55-PRIVATE-SERIAL',
})

let root: string
let bin: string
let install: string
let script: string
let env: NodeJS.ProcessEnv

function stub(command: string, body: string) {
  writeFileSync(join(bin, command), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-welcome-'))
  bin = join(root, 'bin')
  install = join(root, 'install')
  mkdirSync(bin)
  mkdirSync(install)
  writeFileSync(join(root, 'rat_version'), 'f76374f38f9ffed57b320b1b079c6fcf00242bf5\n')
  writeFileSync(join(install, '.git-info'), JSON.stringify({ commitHash: 'abc1234def', branch: 'main', buildDate: '2026-10-05' }))
  writeFileSync(join(install, '.env'), 'PORT=3333\nAPI_TOKEN=secret-for-redaction-test\n')
  script = join(root, 'sp-welcome')
  writeFileSync(script, readFileSync(resolve('scripts/bin/sp-welcome'), 'utf8').replaceAll('/etc/rat_version', join(root, 'rat_version')))
  stub('curl', 'printf "%s" "$MOCK_STATUS"')
  stub('systemctl', 'echo active')
  stub('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mmcblk0p8 6291456 2726298 3565158 91%% /persistent\\n"')
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_DIR: install, MOCK_STATUS: STATUS, COLUMNS: '80' }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(args: string[] = []) {
  return spawnSync('/bin/sh', [script, ...args], { encoding: 'utf8', env, timeout: 20_000 })
}

function widest(output: string) {
  return Math.max(...output.split('\n').map(line => line.length))
}

it('renders the demo as plain ASCII within 80 columns when piped', () => {
  const result = run(['--demo'])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toMatch(/^[\n -~]+$/)
  expect(widest(result.stdout)).toBeLessThanOrEqual(80)
  expect(result.stdout).toMatch(/\.=@@@=\(@@@@@@@@\).*firmware\s+ca35aafa/)
})

it('keeps logo and mask the same shape so colours land on the right cells', () => {
  const source = readFileSync(resolve('scripts/bin/sp-welcome'), 'utf8')
  const block = (tag: string) => source.split(`<<'${tag}'\n`)[1].split(`\n${tag}\n`)[0].split('\n')
  const art = block('ART')
  const mask = block('MASK')
  expect(mask).toHaveLength(art.length)
  art.forEach((line, row) => {
    expect(mask[row].length, `row ${row}`).toBe(line.length)
    expect([...mask[row]].map(c => c === ' '), `row ${row}`).toEqual([...line].map(c => c === ' '))
  })
})

it('keeps the animation geometry on the logo: every Z lands on an empty cell', () => {
  const source = readFileSync(resolve('scripts/bin/sp-welcome'), 'utf8')
  const art = source.split(`<<'ART'\n`)[1].split('\nART\n')[0].split('\n')
  expect(source).toContain(`ART_ROWS=${art.length}\n`)
  const steps = (source.match(/^ZZZ_STEPS='(.+)'$/m)?.[1] ?? '').split(' ')
  expect(steps.length).toBeGreaterThan(0)
  for (let i = 0; i < steps.length; i += 3) {
    const line = art[art.length - Number(steps[i])]
    expect(line.length, `Z ${i / 3}`).toBeLessThan(Number(steps[i + 1]))
  }
})

it.each([{ NO_COLOR: '1' }, {}])('keeps piped output static under --animate with %j', (extra) => {
  Object.assign(env, extra)
  const animated = run(['--demo', '--animate'])
  expect(animated.status, animated.stderr).toBe(0)
  expect(animated.stdout).toBe(run(['--demo']).stdout)
  expect(animated.stdout).toMatch(/^[\n -~]+$/)
})

it.each([79, 77, 60, 40])('drops the panel beneath the logo at %i columns', (columns) => {
  env.COLUMNS = String(columns)
  const result = run(['--demo'])
  const lines = result.stdout.split('\n')
  expect(widest(result.stdout)).toBeLessThanOrEqual(columns)
  if (columns >= 78) expect(lines.findIndex(line => line.includes('uptime'))).toBeLessThan(20)
  else expect(lines.findIndex(line => line.startsWith('host'))).toBeGreaterThan(19)
})

it.each([37, 30, 12, 5])('never overflows a very narrow %i column terminal', (columns) => {
  env.COLUMNS = String(columns)
  expect(widest(run(['--demo']).stdout)).toBeLessThanOrEqual(columns)
})

it('shows live facts without the device serial or env secrets', () => {
  const result = run()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toMatch(/pod\s+Pod 5 \(J55\)/)
  expect(result.stdout).toMatch(/sleepypod\s+abc1234 \(main\)/)
  expect(result.stdout).toMatch(/firmware\s+f76374f38f9f/)
  expect(result.stdout).toMatch(/service\s+active/)
  expect(result.stdout).toMatch(/left\s+74F -> 68F/)
  expect(result.stdout).toMatch(/right\s+71F off/)
  expect(result.stdout).toMatch(/water\s+ok/)
  expect(result.stdout).toMatch(/disk\s+\[#{9}-\] 91% 2\.6G\/6\.0G/)
  expect(result.stdout).not.toContain('PRIVATE-SERIAL')
  expect(result.stdout).not.toContain('secret-for-redaction-test')
})

it.each(['', 'not json', '{"sensorLabel":"unknown"}'])('degrades device facts to dashes for status %j', (status) => {
  env.MOCK_STATUS = status
  const result = run()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  for (const label of ['pod', 'left', 'right', 'water']) expect(result.stdout).toMatch(new RegExp(`${label}\\s+-$`, 'm'))
})

it('renders every row as a dash when nothing is available', () => {
  rmSync(join(root, 'rat_version'))
  rmSync(install, { recursive: true })
  for (const command of ['curl', 'systemctl', 'df']) stub(command, 'exit 1')
  const result = run()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  for (const label of ['pod', 'sleepypod', 'firmware', 'service', 'frank', 'pipeline', 'disk']) {
    expect(result.stdout).toMatch(new RegExp(`${label}\\s+-$`, 'm'))
  }
})

it('bounds hung lookups and still renders', () => {
  for (const command of ['curl', 'systemctl', 'df']) stub(command, 'exec sleep 30')
  const started = Date.now()
  const result = run()
  expect(result.status, result.stderr).toBe(0)
  expect(Date.now() - started).toBeLessThan(6000)
  expect(result.stdout).toMatch(/service\s+-$/m)
  expect(result.stdout).toMatch(/pod\s+-$/m)
})

it('never writes while rendering', () => {
  const before = readdirSync(root, { recursive: true }).sort()
  env.TMPDIR = root
  run()
  expect(readdirSync(root, { recursive: true }).sort()).toEqual(before)
})

it('rejects unknown arguments', () => {
  const result = run(['--nope'])
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('Usage: sp-welcome')
})
