// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), runFile: vi.fn() }))

vi.mock('node:fs/promises', () => ({ stat: mocks.stat }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: mocks.runFile,
  }),
}))

import { discoverSensorSource } from '../sensorSourceDiscovery'

beforeEach(() => {
  mocks.stat.mockReset().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  mocks.runFile.mockReset().mockResolvedValue({ stdout: 'not-found\n' })
})

describe('discoverSensorSource', () => {
  it('selects RAW only when both the NATS unit and JetStream store are absent', async () => {
    expect(await discoverSensorSource()).toBe('raw')
    expect(mocks.stat).toHaveBeenCalledWith('/persistent/jetstream')
    expect(mocks.runFile).toHaveBeenCalledWith('systemctl', [
      'show', 'nats-server.service', '--property=LoadState', '--value',
    ], expect.objectContaining({ timeout: 2000 }))
  })

  it.each(['loaded', 'masked'])('recognizes a %s unit even without JetStream storage', async (state) => {
    mocks.runFile.mockResolvedValue({ stdout: `${state}\n` })
    expect(await discoverSensorSource()).toBe('nats')
  })

  it('recognizes JetStream storage even when systemctl is unavailable', async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => true })
    mocks.runFile.mockRejectedValue(new Error('systemctl unavailable'))
    expect(await discoverSensorSource()).toBe('nats')
  })

  it('recognizes a NATS unit even when storage cannot be inspected', async () => {
    mocks.stat.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    mocks.runFile.mockResolvedValue({ stdout: 'loaded\n' })
    expect(await discoverSensorSource()).toBe('nats')
  })

  it('does not treat a regular file named jetstream as broker storage', async () => {
    mocks.stat.mockResolvedValue({ isDirectory: () => false })
    expect(await discoverSensorSource()).toBe('raw')
  })

  it.each(['error', 'bad-setting', '', 'loading'])('keeps an unrecognized service state %j unknown', async (state) => {
    mocks.runFile.mockResolvedValue({ stdout: state })
    expect(await discoverSensorSource()).toBe('unknown')
  })

  it('does not mistake a storage permissions failure for a RAW-only installation', async () => {
    mocks.stat.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(await discoverSensorSource()).toBe('unknown')
  })

  it('does not mistake a timed-out service query for a RAW-only installation', async () => {
    mocks.runFile.mockRejectedValue(Object.assign(new Error('timeout'), { killed: true }))
    expect(await discoverSensorSource()).toBe('unknown')
  })

  it('inspects service and storage concurrently', async () => {
    let finishStorage!: (value: { isDirectory: () => boolean }) => void
    let finishService!: (value: { stdout: string }) => void
    mocks.stat.mockReturnValue(new Promise((resolve) => {
      finishStorage = resolve
    }))
    mocks.runFile.mockReturnValue(new Promise((resolve) => {
      finishService = resolve
    }))

    const result = discoverSensorSource()
    expect(mocks.stat).toHaveBeenCalledOnce()
    expect(mocks.runFile).toHaveBeenCalledOnce()
    finishStorage({ isDirectory: () => true })
    finishService({ stdout: 'not-found' })
    await expect(result).resolves.toBe('nats')
  })
})
