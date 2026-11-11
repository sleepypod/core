// @vitest-environment node
import type * as ChildProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>()
  return { ...original, execFile: execute, default: { ...original, execFile: execute } }
})
import { submitControllerRestart } from '../restartController'

afterEach(() => {
  vi.unstubAllGlobals()
  execute.mockReset()
})

describe('fixed controller restart submission', () => {
  it('submits only the nonblocking controller service restart with bounded output and time', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    execute.mockImplementationOnce((_file, _arguments, _options, callback) => callback(null, '', ''))
    await submitControllerRestart()
    expect(execute).toHaveBeenCalledExactlyOnceWith('/bin/systemctl', ['--no-block', 'restart', 'sleepypod.service'],
      { timeout: 2000, maxBuffer: 4096, encoding: 'utf8' }, expect.any(Function))
  })
  it('does not execute on a development Mac', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    await expect(submitControllerRestart()).rejects.toThrow('only on the Pod')
    expect(execute).not.toHaveBeenCalled()
  })
})
