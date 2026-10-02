// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn<(file: string, args: string[], options: unknown) => Promise<{ stdout: string }>>(),
  execSync: vi.fn(),
  access: vi.fn(),
}))
vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.runFile }),
}))
vi.mock('node:fs/promises', () => ({ access: mocks.access }))

import { checkAndRepairIptables, checkIptablesCached, invalidateIptablesHealth } from '../iptablesCheck'

const input = 'ACCEPT udp -- 0.0.0.0/0 0.0.0.0/0 udp dpt:5353\nACCEPT all -- 192.168.0.0/16 0.0.0.0/0'
const output = 'ACCEPT udp -- 0.0.0.0/0 0.0.0.0/0 udp dpt:5353\nACCEPT udp -- 0.0.0.0/0 0.0.0.0/0 udp spt:5353\nACCEPT udp -- 0.0.0.0/0 0.0.0.0/0 udp dpt:123'
let now = 0

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__sp_iptables_health__
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.execSync.mockReset()
  mocks.access.mockReset().mockResolvedValue(undefined)
  mocks.runFile.mockReset().mockImplementation(async (file, args) => ({
    stdout: file === 'which' ? '/sbin/iptables\n' : args[1] === 'INPUT' ? input : output,
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__sp_iptables_health__
})

describe('asynchronous firewall health', () => {
  it('coalesces concurrent checks without blocking the event loop and lists each chain once', async () => {
    let release!: (value: { stdout: string }) => void
    mocks.runFile.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    const checks = Array.from({ length: 10 }, () => checkIptablesCached())
    expect(new Set(checks).size).toBe(1)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(mocks.runFile).toHaveBeenCalledOnce()
    release({ stdout: '/sbin/iptables\n' })

    const results = await Promise.all(checks)
    expect(results.every(result => result.ok && result.rules.length === 5)).toBe(true)
    expect(mocks.runFile.mock.calls.slice(1).map(([file, args]) => [file, args])).toEqual([
      ['/sbin/iptables', ['-L', 'INPUT', '-n']],
      ['/sbin/iptables', ['-L', 'OUTPUT', '-n']],
    ])
    expect(mocks.execSync).not.toHaveBeenCalled()
  })

  it('refreshes at 30 seconds and shares the cache across Next module instances', async () => {
    const first = await checkIptablesCached()
    vi.resetModules()
    const duplicate = await import('../iptablesCheck')
    now = 29_999
    expect(await duplicate.checkIptablesCached()).toEqual(first)
    expect(mocks.runFile).toHaveBeenCalledTimes(3)
    now = 30_000
    mocks.runFile.mockResolvedValue({ stdout: '' })
    const refreshed = await duplicate.checkIptablesCached()
    expect(refreshed.ok).toBe(false)
    expect(refreshed.rules.every(rule => !rule.present)).toBe(true)
    expect(mocks.runFile).toHaveBeenCalledTimes(5)
  })

  it('does not let an in-flight pre-repair result overwrite a newer check', async () => {
    let release!: (value: { stdout: string }) => void
    mocks.runFile.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    const stale = checkIptablesCached()
    invalidateIptablesHealth()
    const current = checkIptablesCached()
    mocks.runFile.mockResolvedValueOnce({ stdout: '' }).mockResolvedValueOnce({ stdout: '' })
    release({ stdout: '/sbin/iptables' })

    expect((await stale).ok).toBe(false)
    expect((await current).ok).toBe(true)
    expect((await checkIptablesCached()).ok).toBe(true)
    expect(mocks.runFile).toHaveBeenCalledTimes(5)
  })

  it('invalidates cached health when the synchronous repair path runs', async () => {
    await checkIptablesCached()
    mocks.execSync.mockImplementation((command: string) => command.includes('INPUT') ? input : output)
    checkAndRepairIptables('/sbin/iptables')
    await checkIptablesCached()
    expect(mocks.runFile).toHaveBeenCalledTimes(5)
  })

  it('resolves executable manifest paths when which is unavailable', async () => {
    mocks.runFile.mockRejectedValueOnce(new Error('which missing'))
    await checkIptablesCached()
    expect(mocks.access).toHaveBeenCalledWith('/sbin/iptables', expect.any(Number))
    expect(mocks.runFile.mock.calls[1]?.[0]).toBe('/sbin/iptables')
  })

  it('falls back to PATH lookup when no manifest path is executable', async () => {
    mocks.runFile.mockResolvedValueOnce({ stdout: '' })
    mocks.access.mockRejectedValue(new Error('ENOENT'))
    await checkIptablesCached()
    expect(mocks.runFile.mock.calls[1]?.[0]).toBe('iptables')
  })

  it.each(['ENOENT', 'EACCES', 127, 3, 4])('keeps the established development fallback for unavailable code %s', async (code) => {
    mocks.runFile.mockImplementation(async (file) => {
      if (file === 'which') return { stdout: '/sbin/iptables' }
      throw Object.assign(new Error('unavailable'), { code })
    })
    expect((await checkIptablesCached()).ok).toBe(true)
  })

  it('reports unexpected chain failures as degraded and retries after expiry', async () => {
    mocks.runFile.mockResolvedValueOnce({ stdout: '/sbin/iptables' })
      .mockRejectedValueOnce(new Error('kernel module unavailable'))
    const first = await checkIptablesCached()
    expect(first.ok).toBe(false)
    expect(first.rules.filter(rule => !rule.present).map(rule => rule.chain)).toEqual(['INPUT', 'INPUT'])
    now = 30_000
    expect((await checkIptablesCached()).ok).toBe(true)
  })
})
