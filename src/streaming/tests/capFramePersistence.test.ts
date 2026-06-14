import { beforeEach, describe, expect, it } from 'vitest'
import {
  _getCapFrameWindow,
  recordCapFrame,
  resetCapFrameWindows,
  summarizeWindow,
} from '../capFramePersistence'

const A = [10, 20, 30, 40, 50, 60, 999, 999] // peak zone 2
const B = [60, 50, 40, 30, 20, 10, 0, 0] // peak zone 0

function window(side: 'left' | 'right') {
  const w = _getCapFrameWindow(side)
  if (!w) throw new Error(`no window for ${side}`)
  return w
}

describe('capFramePersistence', () => {
  beforeEach(() => resetCapFrameWindows())

  it('accumulates frames inside a single window without flushing', () => {
    recordCapFrame('left', A, 1000)
    recordCapFrame('left', B, 1002) // +2s, still inside the 5s window

    const w = window('left')
    expect(w.n).toBe(2)
    expect(w.startTsMs).toBe(1_000_000)

    const row = summarizeWindow(w)
    expect(row.frameCount).toBe(2)
    expect(row.max).toBe(60)
    expect(row.spread).toBe(50)
    expect(row.zones).toEqual([35, 35, 35]) // ([15,35,55] + [55,35,15]) / 2
    expect(row.peakZone).toBe(0) // modal of {zone2:1, zone0:1} → first max
    expect(row.timestamp.getTime()).toBe(1_002_000) // last frame ts
  })

  it('rolls over to a fresh window once past the 5s boundary', () => {
    recordCapFrame('left', A, 1000)
    recordCapFrame('left', A, 1006) // +6s ≥ window → flush + new window

    const w = window('left')
    expect(w.n).toBe(1)
    expect(w.startTsMs).toBe(1_006_000)
  })

  it('keeps zones null for a scalar (Pod 3) sensor', () => {
    recordCapFrame('right', 42, 1000)
    const row = summarizeWindow(window('right'))
    expect(row.zones).toBeNull()
    expect(row.peakZone).toBeNull()
    expect(row.max).toBe(42)
    expect(row.spread).toBe(0)
  })

  it('tracks each side independently', () => {
    recordCapFrame('left', A, 1000)
    expect(_getCapFrameWindow('left')?.n).toBe(1)
    expect(_getCapFrameWindow('right')).toBeNull()
  })

  it('resets windows on demand', () => {
    recordCapFrame('left', A, 1000)
    resetCapFrameWindows()
    expect(_getCapFrameWindow('left')).toBeNull()
  })
})
