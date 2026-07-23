import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the suite hermetic: stub the DB so state-machine tests never touch the
// real biometrics schema. The error/throttle tests re-spy these per case.
vi.mock('@/src/db', () => {
  const chain = {
    values: () => chain,
    onConflictDoNothing: () => chain,
    where: () => chain,
    run: () => {},
  }
  return { biometricsDb: { insert: () => chain, delete: () => chain } }
})

import { biometricsDb } from '@/src/db'
import {
  _getCapFrameWindow,
  _resetForTest,
  flushCapFrameWindows,
  recordCapFrame,
  resetCapFrameWindows,
  summarizeWindow,
} from '../capFramePersistence'

const A = [10, 20, 30, 40, 50, 60, 999, 999] // peak zone 2
const B = [60, 50, 40, 30, 20, 10, 0, 0] // peak zone 0
const TS = 1_700_000_000

function window(side: 'left' | 'right') {
  const w = _getCapFrameWindow(side)
  if (!w) throw new Error(`no window for ${side}`)
  return w
}

describe('capFramePersistence', () => {
  beforeEach(() => _resetForTest())

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('accumulates frames inside a single window without flushing', () => {
    recordCapFrame('left', A, TS)
    recordCapFrame('left', B, TS + 2) // +2s, still inside the 5s window

    const w = window('left')
    expect(w.n).toBe(2)
    expect(w.startTsMs).toBe(TS * 1000)

    const row = summarizeWindow(w)
    expect(row.frameCount).toBe(2)
    expect(row.max).toBe(60)
    expect(row.mean).toBe(35)
    expect(row.spread).toBe(50)
    expect(row.zones).toEqual([35, 35, 35]) // ([15,35,55] + [55,35,15]) / 2
    expect(row.peakZone).toBe(0) // modal of {zone2:1, zone0:1} → first max
    expect(row.timestamp.getTime()).toBe((TS + 2) * 1000) // last frame ts
  })

  it('rolls over to a fresh window once past the 5s boundary', () => {
    recordCapFrame('left', A, TS)
    recordCapFrame('left', A, TS + 6) // +6s ≥ window → flush + new window

    const w = window('left')
    expect(w.n).toBe(1)
    expect(w.startTsMs).toBe((TS + 6) * 1000)
  })

  it('rolls over at exactly the inclusive 5s boundary', () => {
    const insert = vi.spyOn(biometricsDb, 'insert')
    recordCapFrame('left', A, TS)

    recordCapFrame('left', B, TS + 5)

    expect(insert).toHaveBeenCalledTimes(1)
    expect(window('left').startTsMs).toBe((TS + 5) * 1000)
    expect(window('left').n).toBe(1)
  })

  it('keeps zones null for a scalar (Pod 3) sensor', () => {
    expect(() => recordCapFrame('right', 42, TS)).not.toThrow()
    const row = summarizeWindow(window('right'))
    expect(row.zones).toBeNull()
    expect(row.peakZone).toBeNull()
    expect(row.max).toBe(42)
    expect(row.spread).toBe(0)
  })

  it('tracks each side independently', () => {
    recordCapFrame('left', A, TS)
    expect(_getCapFrameWindow('left')?.n).toBe(1)
    expect(_getCapFrameWindow('right')).toBeNull()
  })

  it('resets windows on demand', () => {
    recordCapFrame('left', A, TS)
    resetCapFrameWindows()
    expect(_getCapFrameWindow('left')).toBeNull()
  })

  it('skips invalid relative and far-future firmware timestamps', () => {
    recordCapFrame('left', A, 3)
    recordCapFrame('left', A, Date.now() / 1000 + 120)
    recordCapFrame('left', A, Number.NaN)
    recordCapFrame('left', A, Number.POSITIVE_INFINITY)
    recordCapFrame('left', A, Number.NEGATIVE_INFINITY)
    expect(_getCapFrameWindow('left')).toBeNull()
  })

  it('accepts the minimum valid wall-clock timestamp inclusively', () => {
    recordCapFrame('left', A, 1_577_836_800)

    expect(window('left').startTsMs).toBe(1_577_836_800_000)
  })

  it('accepts both the current time and the exact future-skew boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TS * 1000))

    recordCapFrame('left', A, TS)
    recordCapFrame('right', A, TS + 60)

    expect(window('left').startTsMs).toBe(TS * 1000)
    expect(window('right').startTsMs).toBe((TS + 60) * 1000)
  })

  it('flushes non-empty in-flight windows on demand', () => {
    const insert = vi.spyOn(biometricsDb, 'insert')
    const del = vi.spyOn(biometricsDb, 'delete')
    recordCapFrame('left', A, TS)
    flushCapFrameWindows()

    expect(insert).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledTimes(1)
    expect(_getCapFrameWindow('left')).toBeNull()
  })

  it('does nothing when asked to flush empty sides', () => {
    const insert = vi.spyOn(biometricsDb, 'insert')
    const del = vi.spyOn(biometricsDb, 'delete')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    flushCapFrameWindows()

    expect(insert).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(_getCapFrameWindow('left')).toBeNull()
    expect(_getCapFrameWindow('right')).toBeNull()
  })

  it('clears but does not persist an explicitly empty accumulator', () => {
    const insert = vi.spyOn(biometricsDb, 'insert')
    recordCapFrame('left', A, TS)
    window('left').n = 0

    flushCapFrameWindows()

    expect(insert).not.toHaveBeenCalled()
    expect(_getCapFrameWindow('left')).toBeNull()
  })

  it('selects the modal peak zone instead of always choosing zone zero', () => {
    recordCapFrame('left', A, TS)
    recordCapFrame('left', A, TS + 1)
    recordCapFrame('left', B, TS + 2)

    expect(summarizeWindow(window('left')).peakZone).toBe(2)
  })

  describe('capSense status histogram (statusCounts)', () => {
    it('leaves statusCounts null when every sample is "good"', () => {
      recordCapFrame('left', A, TS, 'good')
      recordCapFrame('left', B, TS + 1, 'good')
      expect(summarizeWindow(window('left')).statusCounts).toBeNull()
    })

    it('leaves statusCounts null when frames carry no status (legacy .RAW)', () => {
      recordCapFrame('left', A, TS)
      recordCapFrame('left', B, TS + 1, null)
      expect(summarizeWindow(window('left')).statusCounts).toBeNull()
    })

    it('persists a full histogram (including "good") once any sample is non-good', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      recordCapFrame('left', A, TS, 'good')
      recordCapFrame('left', A, TS + 1, 'good')
      recordCapFrame('left', A, TS + 2, 'warmup')
      expect(summarizeWindow(window('left')).statusCounts).toEqual({ good: 2, warmup: 1 })
    })

    it('tracks status histograms per side independently', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      recordCapFrame('left', A, TS, 'warmup')
      recordCapFrame('right', A, TS, 'good')
      expect(summarizeWindow(window('left')).statusCounts).toEqual({ warmup: 1 })
      expect(summarizeWindow(window('right')).statusCounts).toBeNull()
    })

    it('logs each distinct non-good status once, with side and channel values', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      recordCapFrame('left', A, TS, 'warmup')
      recordCapFrame('left', B, TS + 1, 'warmup')
      recordCapFrame('right', A, TS + 2, 'fault')
      const statusLogs = warn.mock.calls.filter(c => String(c[0]).includes('status='))
      expect(statusLogs).toHaveLength(2)
      expect(warn).toHaveBeenCalledWith('[capFrames] capSense %s status=%s channels=%j', 'left', 'warmup', A)
      expect(warn).toHaveBeenCalledWith('[capFrames] capSense %s status=%s channels=%j', 'right', 'fault', A)
    })

    it('never logs a "good" status', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      recordCapFrame('left', A, TS, 'good')
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('best-effort persistence', () => {
    it('keeps streaming when a flush write throws', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = new Error('db down')
      vi.spyOn(biometricsDb, 'insert').mockImplementation(() => {
        throw error
      })

      recordCapFrame('left', A, TS)
      expect(() => recordCapFrame('left', A, TS + 6)).not.toThrow() // rollover → flush
      expect(warn).toHaveBeenCalledWith('[capFrames] flush failed:', error)
      // A failed write must not stall the stream: the new window still opens.
      expect(_getCapFrameWindow('left')?.n).toBe(1)
    })

    it('keeps streaming and reports the exact error when pruning fails', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = new Error('delete failed')
      vi.spyOn(biometricsDb, 'delete').mockImplementation(() => {
        throw error
      })

      recordCapFrame('left', A, TS)
      expect(() => recordCapFrame('left', A, TS + 5)).not.toThrow()

      expect(warn).toHaveBeenCalledWith('[capFrames] prune failed:', error)
      expect(window('left').n).toBe(1)
    })

    it('throttles pruning across rapid rollovers', () => {
      const del = vi.spyOn(biometricsDb, 'delete')
      vi.spyOn(biometricsDb, 'insert').mockImplementation(() => {
        throw new Error('skip write')
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      recordCapFrame('left', A, TS)
      recordCapFrame('left', A, TS + 6) // first rollover → prune runs
      recordCapFrame('left', A, TS + 12) // second rollover within 10min → throttled
      expect(del).toHaveBeenCalledTimes(1)
    })

    it('prunes again at exactly the 10-minute throttle boundary', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(TS * 1000))
      const del = vi.spyOn(biometricsDb, 'delete')

      recordCapFrame('left', A, TS)
      recordCapFrame('left', A, TS + 5)
      expect(del).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(10 * 60_000)
      recordCapFrame('left', A, TS + 10)

      expect(del).toHaveBeenCalledTimes(2)
    })

    it('prunes rows older than exactly 48 hours before the current wall clock', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(TS * 1000))
      const run = vi.fn()
      const where = vi.fn((condition: unknown) => {
        void condition
        return { run }
      })
      vi.spyOn(biometricsDb, 'delete').mockReturnValue({ where } as never)

      recordCapFrame('left', A, TS)
      recordCapFrame('left', A, TS + 5)

      const condition = where.mock.calls[0]?.[0] as unknown as {
        queryChunks: Array<{ value?: unknown }>
      }
      const cutoff = condition.queryChunks.find(chunk => chunk.value instanceof Date)?.value
      expect(cutoff).toEqual(new Date(TS * 1000 - 48 * 60 * 60_000))
      expect(run).toHaveBeenCalledOnce()
    })
  })

  describe('module initialization contracts', () => {
    async function loadFreshModule() {
      vi.resetModules()
      const persistence = await import('../capFramePersistence')
      const { biometricsDb: freshBiometricsDb } = await import('@/src/db')
      persistence._resetForTest()
      return { persistence, freshBiometricsDb }
    }

    it('uses the full 48-hour retention interval after a fresh import', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(TS * 1000))
      const { persistence, freshBiometricsDb } = await loadFreshModule()
      const run = vi.fn()
      const where = vi.fn((condition: unknown) => {
        void condition
        return { run }
      })
      vi.spyOn(freshBiometricsDb, 'delete').mockReturnValue({ where } as never)

      persistence.recordCapFrame('left', A, TS)
      persistence.recordCapFrame('left', A, TS + 5)

      const condition = where.mock.calls[0]?.[0] as unknown as {
        queryChunks: Array<{ value?: unknown }>
      }
      const cutoff = condition.queryChunks.find(chunk => chunk.value instanceof Date)?.value
      expect(cutoff).toEqual(new Date(TS * 1000 - 48 * 60 * 60_000))
      expect(run).toHaveBeenCalledOnce()
    })

    it('keeps the full 10-minute prune throttle after a fresh import', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(TS * 1000))
      const { persistence, freshBiometricsDb } = await loadFreshModule()
      const del = vi.spyOn(freshBiometricsDb, 'delete')

      persistence.recordCapFrame('left', A, TS)
      persistence.recordCapFrame('left', A, TS + 5)
      expect(del).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(1)
      persistence.recordCapFrame('left', A, TS + 10)
      expect(del).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(10 * 60_000 - 1)
      persistence.recordCapFrame('left', A, TS + 15)
      expect(del).toHaveBeenCalledTimes(2)
    })
  })
})
