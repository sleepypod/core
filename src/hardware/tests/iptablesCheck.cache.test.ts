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
import { APP_BLOCK_WAN, DROP_ONLY, FLUSHED, INSTALL_BLOCK_WAN, INTERNET_CONTROL_BLOCK, pick, type Ruleset } from './iptablesRulesets'

const input = INSTALL_BLOCK_WAN.INPUT
const output = INSTALL_BLOCK_WAN.OUTPUT
function serve(ruleset: Ruleset) {
  mocks.runFile.mockImplementation(async (file, args) => {
    if (file === 'which') return { stdout: '/sbin/iptables\n' }
    const listing = ruleset[args[1] ?? '']
    if (listing === undefined) throw Object.assign(new Error('No chain/target/match by that name.'), { code: 1 })
    return { stdout: listing }
  })
}
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
      ['/sbin/iptables', ['-S', 'INPUT']],
      ['/sbin/iptables', ['-S', 'OUTPUT']],
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
    mocks.runFile.mockImplementation(async (_file, args) => ({ stdout: pick(DROP_ONLY, args[1]) }))
    const refreshed = await duplicate.checkIptablesCached()
    expect(refreshed.ok).toBe(false)
    expect(refreshed.rules.every(rule => !rule.present)).toBe(true)
    expect(mocks.runFile).toHaveBeenCalledTimes(5)
  })

  it('reports no missing rules while internet access is allowed (chains open)', async () => {
    serve(FLUSHED)
    const status = await checkIptablesCached()
    expect(status.ok).toBe(true)
    expect(status.rules.every(rule => rule.present)).toBe(true)
    // Not blocking anything: must not read as a firewall in place.
    expect(status.state).toBe('open')
  })

  it.each([
    ['install block_wan', INSTALL_BLOCK_WAN],
    ['the app\'s blockWan', APP_BLOCK_WAN],
    ['internet-control block', INTERNET_CONTROL_BLOCK],
  ])('reports %s as blocking with nothing missing', async (_name, ruleset) => {
    serve(ruleset)
    const status = await checkIptablesCached()
    expect(status).toEqual(expect.objectContaining({ ok: true, state: 'blocking' }))
    expect(status.rules.every(rule => rule.present)).toBe(true)
  })

  it('follows the jump to SLEEPYPOD-BLOCK with one extra listing', async () => {
    serve(INTERNET_CONTROL_BLOCK)
    await checkIptablesCached()
    expect(mocks.runFile.mock.calls.map(([, args]) => args)).toEqual([['iptables'], ['-S', 'INPUT'], ['-S', 'OUTPUT'], ['-S', 'SLEEPYPOD-BLOCK']])
  })

  it.each([
    ['a broad ACCEPT before the DROP', { ...INSTALL_BLOCK_WAN, OUTPUT: output.replace('-A OUTPUT -o lo -j ACCEPT\n', '-A OUTPUT -j ACCEPT\n') }, 'open'],
    ['policy DROP with no DROP rule', { ...INSTALL_BLOCK_WAN, OUTPUT: output.replace('-A OUTPUT -j DROP\n', '') }, 'blocking'],
    ['policy ACCEPT with a DROP for one destination', { INPUT: FLUSHED.INPUT, OUTPUT: '-P OUTPUT ACCEPT\n-A OUTPUT -d 203.0.113.7/32 -j DROP\n' }, 'open'],
  ] as const)('evaluates rule order: %s', async (_name, ruleset, state) => {
    serve(ruleset)
    expect((await checkIptablesCached()).state).toBe(state)
  })

  it('reports an unparseable listing as unknown', async () => {
    serve({ INPUT: FLUSHED.INPUT, OUTPUT: 'Chain OUTPUT (policy ACCEPT)\n' })
    expect(await checkIptablesCached()).toEqual(expect.objectContaining({ ok: false, state: 'unknown' }))
  })

  it('does not let an in-flight pre-repair result overwrite a newer check', async () => {
    let release!: (value: { stdout: string }) => void
    mocks.runFile.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
    const stale = checkIptablesCached()
    invalidateIptablesHealth()
    const current = checkIptablesCached()
    mocks.runFile.mockResolvedValueOnce({ stdout: DROP_ONLY.INPUT }).mockResolvedValueOnce({ stdout: DROP_ONLY.OUTPUT })
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

  it.each(['ENOENT', 127])('keeps the development fallback when the binary is absent (code %s)', async (code) => {
    mocks.runFile.mockImplementation(async (file) => {
      if (file === 'which') return { stdout: '/sbin/iptables' }
      throw Object.assign(new Error('unavailable'), { code })
    })
    expect(await checkIptablesCached()).toEqual(expect.objectContaining({ ok: true, state: 'unknown' }))
  })

  it.each(['EACCES', 3, 4])('reports an iptables that exists but cannot be listed as unknown (code %s)', async (code) => {
    mocks.runFile.mockImplementation(async (file) => {
      if (file === 'which') return { stdout: '/sbin/iptables' }
      throw Object.assign(new Error('unavailable'), { code })
    })
    const status = await checkIptablesCached()
    expect(status).toEqual(expect.objectContaining({ ok: false, state: 'unknown' }))
    expect(status.rules.every(rule => rule.present)).toBe(true)
  })

  it('reports unexpected chain failures as degraded and retries after expiry', async () => {
    mocks.runFile.mockResolvedValueOnce({ stdout: '/sbin/iptables' })
      .mockRejectedValueOnce(new Error('kernel module unavailable'))
    const first = await checkIptablesCached()
    expect(first).toEqual(expect.objectContaining({ ok: false, state: 'unknown' }))
    expect(console.warn).toHaveBeenCalledWith('[iptables] Failed to check INPUT: kernel module unavailable')
    now = 30_000
    expect((await checkIptablesCached()).ok).toBe(true)
  })
})
