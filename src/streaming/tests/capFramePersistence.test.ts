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

  it('accumulates frames inside a single window without flushing', () => {
    recordCapFrame('left', A, TS)
    recordCapFrame('left', B, TS + 2) // +2s, still inside the 5s window

    const w = window('left')
    expect(w.n).toBe(2)
    expect(w.startTsMs).toBe(TS * 1000)

    const row = summarizeWindow(w)
    expect(row.frameCount).toBe(2)
    expect(row.max).toBe(60)
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

  it('keeps zones null for a scalar (Pod 3) sensor', () => {
    recordCapFrame('right', 42, TS)
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
    expect(_getCapFrameWindow('left')).toBeNull()
  })

  it('flushes non-empty in-flight windows on demand', () => {
    const insert = vi.spyOn(biometricsDb, 'insert')
    recordCapFrame('left', A, TS)
    flushCapFrameWindows()

    expect(insert).toHaveBeenCalledTimes(1)
    expect(_getCapFrameWindow('left')).toBeNull()
  })

  describe('best-effort persistence', () => {
    afterEach(() => vi.restoreAllMocks())

    it('keeps streaming when a flush write throws', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(biometricsDb, 'insert').mockImplementation(() => {
        throw new Error('db down')
      })

      recordCapFrame('left', A, TS)
      expect(() => recordCapFrame('left', A, TS + 6)).not.toThrow() // rollover → flush
      expect(warn).toHaveBeenCalled()
      // A failed write must not stall the stream: the new window still opens.
      expect(_getCapFrameWindow('left')?.n).toBe(1)
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
  })
})
