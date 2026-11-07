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

/** Install a shell command fixture on the isolated lookup PATH. */
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
  stub('curl', 'for arg do url=$arg; done; [ "$url" = "http://127.0.0.1:${EXPECTED_PORT:-3000}/api/device/status" ] || exit 1; printf "%s" "$MOCK_STATUS"')
  stub('systemctl', 'echo active')
  stub('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mmcblk0p8 6291456 2726298 3565158 91%% /persistent\\n"')
  env = { ...process.env, PORT: undefined, PATH: `${bin}:${process.env.PATH}`, INSTALL_DIR: install, MOCK_STATUS: STATUS, COLUMNS: '80' }
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
  expect(result.stdout).toMatch(/firmware\s+ca35aafa/)
})

it('keeps the ASCII and pixel silhouettes aligned with the reference moon', () => {
  const source = readFileSync(resolve('scripts/bin/sp-welcome'), 'utf8')
  const block = (tag: string) => source.split(`<<'${tag}'\n`)[1].split(`\n${tag}\n`)[0].split('\n')
  const art = block('ART')
  const pixels = block('PIXELS').map(row => row.split(' '))
  expect(pixels).toHaveLength(art.length * 2)
  art.forEach((line, row) => {
    for (let col = 0; col < 38; col++) {
      const visible = pixels[row * 2][col] !== '-' || pixels[row * 2 + 1][col] !== '-'
      expect((line[col] ?? ' ') !== ' ', `row ${row}, col ${col}`).toBe(visible)
    }
  })
  // The supplied logo has its higher moon tip on the left, with the curved
  // illuminated lower edge beneath it. Guard against mirroring either axis.
  expect(art[0].trim()).toBe('.')
  expect(art[0].indexOf('.')).toBe(10)
  expect(art[2].trim().length).toBeGreaterThan(art[0].trim().length)
  expect(art[6].trim().length).toBeLessThan(art[4].trim().length)
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
  if (columns >= 78) expect(lines.findIndex(line => line.includes('uptime'))).toBeLessThan(25)
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

it('keeps the disk bar on a full-size eMMC, where the sizes are at their widest', () => {
  stub('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mmcblk0p8 15129544 11459508 2867220 81%% /persistent\\n"')
  const result = run()
  expect(result.stdout).toMatch(/disk\s+\[#{8}--\] 81% 10\.9G\/14\.4G/)
  expect(widest(result.stdout)).toBeLessThanOrEqual(80)
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
  const fixtures = [join(root, 'rat_version'), join(install, '.git-info'), join(install, '.env')]
  const contents = fixtures.map(path => readFileSync(path, 'utf8'))
  env.TMPDIR = root
  run()
  expect(fixtures.map(path => readFileSync(path, 'utf8'))).toEqual(contents)
  expect(readdirSync(root, { recursive: true }).sort()).toEqual(before)
})

it('rejects unknown arguments', () => {
  const result = run(['--nope'])
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('Usage: sp-welcome')
})

/** Capture a real terminal with redirected stdin, as on an SSH terminal. */
function runPty(args: string[] = [], columns = 100) {
  return spawnSync('python3', ['-c', `
import errno, fcntl, os, pty, struct, subprocess, sys, termios
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, ${columns}, 0, 0))
child = subprocess.Popen(["/bin/sh", *sys.argv[1:]], stdin=subprocess.DEVNULL, stdout=slave, stderr=slave)
os.close(slave)
while True:
    try:
        data = os.read(master, 65536)
        if not data: break
        sys.stdout.buffer.write(data)
    except OSError as error:
        if error.errno != errno.EIO: raise
        break
os.close(master)
sys.exit(child.wait())
`, script, ...args], { encoding: 'utf8', env: { ...env, TERM: 'xterm-256color', NO_COLOR: '' }, timeout: 20_000 })
}

it('adds one blank line above and below the screen', () => {
  const output = run(['--demo']).stdout
  expect(output.startsWith('\n')).toBe(true)
  expect(output.endsWith('\n\n')).toBe(true)
})

it('aligns coloured terminal labels by visible width and restores the animated cursor', () => {
  const result = runPty(['--demo', '--animate'])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('\x1b[?25l')
  expect(result.stdout).toContain('\x1b[?25h')
  // Strip terminal controls to compare the visible columns.
  // eslint-disable-next-line no-control-regex
  const plain = result.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replaceAll('\r', '')
  expect(plain).toMatch(/host {6}demo-pod/)
  expect(plain).toMatch(/service {3}active/)
})

it('colours low water red even while priming', () => {
  env.MOCK_STATUS = STATUS.replace('"ok"', '"low"').replace('"isPriming":false', '"isPriming":true')
  expect(runPty().stdout).toContain('\x1b[38;5;203mlow, priming')
})

it.each(['150', '-10'])('clamps a %s percent disk bar to its allotted width', (percent) => {
  stub('df', `printf 'Filesystem blocks Used Available Capacity Mounted\\n/dev/disk 100 50 50 ${percent}%% /persistent\\n'`)
  const result = run()
  expect(result.stdout).toMatch(/disk\s+\[[#-]{10}\]/)
  expect(widest(result.stdout)).toBeLessThanOrEqual(80)
})

it('bounds shell lookups whose descendants inherit the output pipe', () => {
  stub('df', 'sleep 30 & wait')
  const started = Date.now()
  const result = run()
  expect(result.status, result.stderr).toBe(0)
  expect(Date.now() - started).toBeLessThan(6000)
  expect(result.stdout).toMatch(/disk\s+-$/m)
})

it('bounds a blocked metadata read', () => {
  rmSync(join(install, '.git-info'))
  expect(spawnSync('mkfifo', [join(install, '.git-info')]).status).toBe(0)
  const started = Date.now()
  const result = run()
  expect(result.status, result.stderr).toBe(0)
  expect(Date.now() - started).toBeLessThan(6000)
  expect(result.stdout).toMatch(/sleepypod\s+-$/m)
})

it('shows configured DNS blocks only when the local resolver is in use', () => {
  const config = join(root, 'dnsmasq.conf')
  writeFileSync(config, 'address=/8slp.net/\naddress=/example.org/\n')
  writeFileSync(script, readFileSync(script, 'utf8').replaceAll('/etc/sleepypod/dnsmasq.conf', config))
  stub('readlink', 'echo /etc/sleepypod/resolv.conf')
  expect(run().stdout).toMatch(/blocked\s+\*\.8slp.net, \*\.example.org/)
  stub('readlink', 'echo /run/NetworkManager/resolv.conf')
  expect(run().stdout).toMatch(/blocked\s+-$/m)
})

it('keeps the SSH login hook silent for noninteractive commands', () => {
  const result = spawnSync('/bin/sh', ['scripts/profile.d/sleepypod-welcome.sh'], {
    encoding: 'utf8', env: { ...env, SSH_CONNECTION: 'test' },
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
})

it.each(['4321', '0', '65536', 'invalid'])('uses a valid running service port (%s) with a default fallback', (port) => {
  const proc = join(root, 'proc', '123')
  mkdirSync(proc, { recursive: true })
  writeFileSync(join(proc, 'environ'), `NODE_ENV=production\0PORT=${port}\0`)
  writeFileSync(script, readFileSync(script, 'utf8').replace('Path("/proc", pid', `Path("${join(root, 'proc')}", pid`))
  stub('systemctl', 'if [ "$1" = show ]; then echo 123; else echo active; fi')
  env.EXPECTED_PORT = port === '4321' ? port : '3000'
  env.PORT = '9999'
  expect(run().stdout).toMatch(/pod\s+Pod 5/)
})

it.each([80, 60, 37])('fits the pixel logo and facts into a %i-column colour terminal', (columns) => {
  const result = runPty(['--demo'], columns)
  expect(result.status, result.stderr).toBe(0)
  // eslint-disable-next-line no-control-regex
  const plain = result.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replaceAll('\r', '')
  expect(widest(plain)).toBeLessThanOrEqual(columns)
  expect(plain).toContain('demo-pod')
  if (columns >= 38) expect(plain).toMatch(/[▀▄]/)
  else expect(plain).not.toMatch(/[▀▄]/)
  expect(result.stdout).not.toContain('\x1b[?25l')
})

it('keeps the pixel raster at two pixels per cell with a transparent silhouette', () => {
  const source = readFileSync(resolve('scripts/bin/sp-welcome'), 'utf8')
  const pixels = source.split('<<\'PIXELS\'\n')[1].split('\nPIXELS\n')[0].split('\n').map(row => row.split(' '))
  expect(pixels).toHaveLength(40)
  for (const row of pixels) {
    expect(row).toHaveLength(38)
    for (const pixel of row) {
      if (pixel !== '-') {
        expect(Number(pixel)).toBeGreaterThanOrEqual(16)
        expect(Number(pixel)).toBeLessThanOrEqual(255)
      }
    }
  }
  expect(pixels[0][0]).toBe('-')
})

it('uses solid gradient bars and colours temperature numbers independently', () => {
  const output = runPty(['--demo']).stdout
  expect(output).toContain('\x1b[38;5;29m█')
  expect(output).toContain('\x1b[38;5;114m█')
  expect(output).toContain('\x1b[38;5;117m74F\x1b[0m -> ')
  expect(output).toContain('\x1b[38;5;240moff\x1b[0m')
  env.MOCK_STATUS = STATUS.replace('74.4', '90')
  expect(runPty().stdout).toContain('\x1b[38;5;209m90F')
})

it('uses the SSH destination for the web URL, including IPv6', () => {
  env.SSH_CONNECTION = '192.168.1.1 1234 192.168.1.88 8822'
  expect(run().stdout).toContain('http://192.168.1.88:3000')
  env.SSH_CONNECTION = '::1 1234 fd00::88 8822'
  expect(run().stdout).toContain('http://[fd00::88]:3000')
})

it('shows unavailable eMMC counters as a dash', () => {
  writeFileSync(script, readFileSync(script, 'utf8').replace('Path("/sys/block", name', `Path("${root}/missing", name`))
  expect(run().stdout).toMatch(/writes\s+-$/m)
})

it('samples actual eMMC counter deltas without writing a cache', () => {
  const block = join(root, 'block', 'mmcblk0')
  mkdirSync(block, { recursive: true })
  writeFileSync(join(block, 'stat'), '0 0 0 0 0 0 100 0')
  writeFileSync(script, readFileSync(script, 'utf8')
    .replace('Path("/sys/block", name', `Path("${root}/block", name`))
  // A child changes the kernel-counter fixture during the sample interval.
  stub('python3', `if [ "$1" = -c ]; then
case "$2" in *'time.sleep(1)'*)
  (sleep 0.5; printf '0 0 0 0 0 0 2148 0' > '${block}/stat') &
;; esac
fi
exec '${spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim()}' "$@"`)
  const output = run().stdout
  expect(output).toMatch(/writes\s+10[0-2][0-9]\.[0-9] KiB\/s \(1s\)/)
})
