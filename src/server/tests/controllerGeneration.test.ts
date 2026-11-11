// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { isNewControllerGeneration, readControllerGeneration } from '../controllerGeneration'

function fixture() {
  const clock = { now: 1794404000000 }
  const properties = { MainPID: '1234', ActiveState: 'active', SubState: 'running', InvocationID: 'a'.repeat(32) }
  const source: { boot: string, stat: string } = {
    boot: randomUUID(),
    stat: `1234 (node (core worker)) S ${Array(18).fill('0').join(' ')} 987654 0 0\n`,
  }
  const show = vi.fn(async () => Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')
  const read = vi.fn(async (path: string) => {
    if (path === '/proc/1234/stat') return source.stat
    if (path === '/proc/sys/kernel/random/boot_id') return `${source.boot}\n`
    throw new Error('Unexpected file')
  })
  const dependencies = { platform: 'linux', pid: 1234, invocationId: properties.InvocationID, now: () => clock.now, show, read }
  return { clock, properties, source, show, read, dependencies }
}

describe('controller service generation', () => {
  it('requires the actual active MainPID, service invocation and kernel process start identity', async () => {
    const setup = fixture()
    expect(await readControllerGeneration(setup.dependencies)).toEqual({
      version: 1, invocationId: 'a'.repeat(32), bootId: setup.source.boot, pid: 1234,
      startTicks: '987654', observedAt: setup.clock.now,
    })
    expect(setup.show).toHaveBeenCalledTimes(2)
    expect(setup.read.mock.calls.map(([path]) => path).sort()).toEqual(['/proc/1234/stat', '/proc/sys/kernel/random/boot_id'])
  })

  it.each(['macOS', 'missing-invocation', 'malformed-invocation'])('rejects %s before querying any service', async (problem) => {
    const setup = fixture()
    if (problem === 'macOS') setup.dependencies.platform = 'darwin'
    else setup.dependencies.invocationId = problem === 'missing-invocation' ? '' : 'incorrect'
    await expect(readControllerGeneration(setup.dependencies)).rejects.toThrow()
    expect(setup.show).not.toHaveBeenCalled()
    expect(setup.read).not.toHaveBeenCalled()
  })

  it.each(['wrong-pid', 'wrong-invocation', 'inactive', 'stopping', 'duplicate', 'missing', 'extra', 'oversized',
    'proc-pid', 'proc-state', 'proc-time', 'proc-truncated', 'proc-oversized', 'boot-invalid', 'boot-oversized',
    'lost-file', 'lost-service', 'changed-during-read', 'clock-backward', 'expired-read'])(
    'withholds %s proof', async (problem) => {
      const setup = fixture()
      if (problem === 'wrong-pid') setup.properties.MainPID = '5678'
      if (problem === 'wrong-invocation') setup.properties.InvocationID = 'b'.repeat(32)
      if (problem === 'inactive') setup.properties.ActiveState = 'inactive'
      if (problem === 'stopping') setup.properties.SubState = 'stop-sigterm'
      if (problem === 'duplicate') setup.show.mockImplementation(async () => 'MainPID=1234\nMainPID=1234\n')
      if (problem === 'missing') setup.show.mockImplementation(async () => 'MainPID=1234\n')
      if (problem === 'extra') setup.show.mockImplementation(async () => 'Other=unexpected\n')
      if (problem === 'oversized') setup.show.mockImplementation(async () => 'a'.repeat(4097))
      if (problem === 'proc-pid') setup.source.stat = setup.source.stat.replace('1234', '4321')
      if (problem === 'proc-state') setup.source.stat = setup.source.stat.replace(' S ', ' Z ')
      if (problem === 'proc-time') setup.source.stat = setup.source.stat.replace('987654', '-1')
      if (problem === 'proc-truncated') setup.source.stat = '1234 (node) S 0'
      if (problem === 'proc-oversized') setup.source.stat = 'x'.repeat(16385)
      if (problem === 'boot-invalid') setup.source.boot = 'unknown'
      if (problem === 'boot-oversized') setup.source.boot = 'x'.repeat(65)
      if (problem === 'lost-file') setup.read.mockRejectedValue(new Error('File unavailable'))
      if (problem === 'lost-service') setup.show.mockRejectedValue(new Error('Service unavailable'))
      if (problem === 'changed-during-read') setup.read.mockImplementation(async () => {
        setup.properties.InvocationID = 'b'.repeat(32)
        return setup.source.boot
      })
      if (problem === 'clock-backward' || problem === 'expired-read') setup.read.mockImplementation(async (path) => {
        setup.clock.now += problem === 'clock-backward' ? -1 : 5001
        return path.endsWith('/stat') ? setup.source.stat : setup.source.boot
      })
      await expect(readControllerGeneration(setup.dependencies)).rejects.toThrow()
    },
  )

  it('does not mistake a changed app ID, invocation alone, PID reuse or a stale proof for restart', async () => {
    const setup = fixture()
    const before = await readControllerGeneration(setup.dependencies)
    const now = setup.clock.now + 1000
    const current = { ...before, observedAt: now }
    expect(isNewControllerGeneration(before, current, now)).toBe(false)
    expect(isNewControllerGeneration(before, { ...current, invocationId: 'b'.repeat(32) }, now)).toBe(false)
    expect(isNewControllerGeneration(before, { ...current, pid: 4321 }, now)).toBe(false)
    expect(isNewControllerGeneration(before, { ...current, pid: 4321, invocationId: 'b'.repeat(32), startTicks: '987653' }, now)).toBe(false)
    expect(isNewControllerGeneration(before, { ...current, invocationId: 'b'.repeat(32), bootId: before.bootId.toUpperCase() }, now)).toBe(false)
    const restarted = { ...current, invocationId: 'b'.repeat(32), startTicks: '987655' }
    expect(isNewControllerGeneration(before, restarted, now)).toBe(true)
    expect(isNewControllerGeneration(before, { ...restarted, observedAt: now + 1 }, now)).toBe(false)
    expect(isNewControllerGeneration(before, restarted, now + 5001)).toBe(false)
    expect(isNewControllerGeneration({ ...before, observedAt: now + 1 }, restarted, now)).toBe(false)
    expect(isNewControllerGeneration(before, { ...restarted, startTicks: '' }, now)).toBe(false)
    expect(isNewControllerGeneration(before, { ...restarted, startTicks: 'unknown' }, now)).toBe(false)
    expect(isNewControllerGeneration(before, { ...restarted, startTicks: '18446744073709551616' }, now)).toBe(false)
    expect(isNewControllerGeneration(before, restarted, Number.NaN)).toBe(false)
    expect(isNewControllerGeneration(null, restarted, now)).toBe(false)
  })
})
