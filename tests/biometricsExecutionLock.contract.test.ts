import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const installScript = readFileSync(join(process.cwd(), 'scripts/install'), 'utf8')
const updateScript = readFileSync(join(process.cwd(), 'scripts/bin/sp-update'), 'utf8')
const lockModule = readFileSync(join(process.cwd(), 'modules/common/biometrics/execution_lock.py'), 'utf8')
const lockPath = lockModule.match(/^EXECUTION_LOCK_PATH = '([^']+)'/m)?.[1]
const step = installScript.split('\n').find(line => line.startsWith('ExecStartPre=+') && lockPath !== undefined && line.includes(lockPath))

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('biometric execution lock deployment contract', () => {
  it('prepares the workers’ lock for the unprivileged service user as root on every start', () => {
    expect(lockPath).toBe('/run/sleepypod-shadow.lock')
    expect(installScript).toMatch(/^User=sleepypod$/m)
    expect(step).toBeDefined()
    expect(step).toContain(`chown sleepypod:sleepypod ${lockPath}`)
    expect(step).toContain(`chmod 600 ${lockPath}`)
  })

  it('gives pods upgraded over the air the same step as a drop-in, before the service starts', () => {
    const dropIn = updateScript.split('\n').find(line => line.startsWith('ExecStartPre=+') && lockPath !== undefined && line.includes(lockPath))
    expect(dropIn).toBe(step)
    expect(updateScript).toContain('/etc/systemd/system/sleepypod.service.d/biometrics-execution-lock.conf')
    expect(updateScript.indexOf('EXECUTION_LOCK_DROPIN=')).toBeLessThan(updateScript.indexOf('systemctl start sleepypod.service\n', updateScript.indexOf('echo "Starting service..."')))
  })

  it('adopts an existing lock without truncating or replacing the inode a worker may hold', () => {
    dir = mkdtempSync(join(tmpdir(), 'exec-lock-'))
    const target = join(dir, 'lock')
    const command = step?.match(/sh -c '(.*)'$/)?.[1]
    if (!command || !lockPath) throw new Error('Lock preparation step not found')
    // Exercise the redirect only; ownership changes need root.
    const create = command.split(' && ')[0].replaceAll(lockPath, target)
    execFileSync('/bin/sh', ['-c', create])
    expect(statSync(target).size).toBe(0)
    writeFileSync(target, '')
    const inode = statSync(target).ino
    execFileSync('/bin/sh', ['-c', create])
    expect(statSync(target).ino).toBe(inode)
    expect(statSync(target).size).toBe(0)
  })
})
