import { describe, expect, it, vi } from 'vitest'
import type { GestureEvent } from '../dacMonitor'
import { GestureDispatcher, STREAM_TAP_FRESH_MS, TAP_RECORD_MAX_AGE_S, tapGestureEvent } from '../gestureDispatch'

const NOW_S = 1_790_680_560

describe('tapGestureEvent', () => {
  it.each([[2, 'doubleTap'], [3, 'tripleTap'], [4, 'quadTap']] as const)('maps %i taps to %s', (taps, tapType) => {
    const event = tapGestureEvent({ type: 'tap-gesture', side: 'left', taps, ts: NOW_S - 6 }, NOW_S * 1000)
    expect(event).toEqual({ side: 'left', tapType, timestamp: new Date((NOW_S - 6) * 1000), firmwareTime: NOW_S - 6 })
  })

  it('ignores other frames and malformed records', () => {
    const now = NOW_S * 1000
    expect(tapGestureEvent({ type: 'frzHealth', side: 'left', taps: 2, ts: NOW_S }, now)).toBeNull()
    expect(tapGestureEvent({ type: 'tap-gesture', side: 'middle', taps: 2, ts: NOW_S }, now)).toBeNull()
    expect(tapGestureEvent({ type: 'tap-gesture', side: 'left', taps: 1, ts: NOW_S }, now)).toBeNull()
    expect(tapGestureEvent({ type: 'tap-gesture', side: 'left', taps: 2 }, now)).toBeNull()
  })

  it('ignores a record replayed from before a restart', () => {
    const now = NOW_S * 1000
    expect(tapGestureEvent({ type: 'tap-gesture', side: 'right', taps: 2, ts: NOW_S - TAP_RECORD_MAX_AGE_S }, now)).not.toBeNull()
    expect(tapGestureEvent({ type: 'tap-gesture', side: 'right', taps: 2, ts: NOW_S - TAP_RECORD_MAX_AGE_S - 1 }, now)).toBeNull()
  })
})

describe('GestureDispatcher', () => {
  const tap = (tapType: GestureEvent['tapType'], firmwareTime?: number): GestureEvent =>
    ({ side: 'left', tapType, timestamp: new Date(), ...(firmwareTime != null && { firmwareTime }) })

  it('handles a tap reported by both sources once', () => {
    const deliver = vi.fn()
    const d = new GestureDispatcher(deliver, () => NOW_S * 1000)
    d.fromStatus(tap('tripleTap', NOW_S))
    d.fromStream(tap('tripleTap', NOW_S))
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('handles two quick taps of the same kind as two gestures', () => {
    const deliver = vi.fn()
    const d = new GestureDispatcher(deliver, () => NOW_S * 1000)
    d.fromStream(tap('tripleTap', NOW_S - 2))
    d.fromStream(tap('tripleTap', NOW_S))
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('takes a tap only the stream reports (one that stopped an alarm)', () => {
    const deliver = vi.fn()
    new GestureDispatcher(deliver, () => NOW_S * 1000).fromStream(tap('doubleTap', NOW_S))
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ tapType: 'doubleTap' }))
  })

  it('while the stream is delivering taps, status taps are ignored', () => {
    const deliver = vi.fn()
    let now = NOW_S * 1000
    const d = new GestureDispatcher(deliver, () => now)
    d.fromStream(tap('doubleTap', NOW_S))
    now += STREAM_TAP_FRESH_MS
    d.fromStatus(tap('tripleTap', NOW_S + 5))
    d.fromStatus(tap('quadTap'))
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('takes status taps again once the stream has gone quiet', () => {
    const deliver = vi.fn()
    let now = NOW_S * 1000
    const d = new GestureDispatcher(deliver, () => now)
    d.fromStream(tap('doubleTap', NOW_S))
    now += STREAM_TAP_FRESH_MS + 1
    d.fromStatus(tap('tripleTap', NOW_S + 31))
    expect(deliver).toHaveBeenCalledTimes(2)
    d.fromStream(tap('quadTap', NOW_S + 40))
    d.fromStatus(tap('doubleTap', NOW_S + 41))
    expect(deliver).toHaveBeenCalledTimes(3)
  })

  it('without firmware times, status taps are each delivered', () => {
    const deliver = vi.fn()
    const d = new GestureDispatcher(deliver, () => NOW_S * 1000)
    d.fromStatus(tap('doubleTap'))
    d.fromStatus(tap('doubleTap'))
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('forgets handled taps after a while', () => {
    const deliver = vi.fn()
    let now = NOW_S * 1000
    const d = new GestureDispatcher(deliver, () => now)
    d.fromStatus(tap('tripleTap', NOW_S))
    now += 6 * 60 * 1000
    d.fromStatus(tap('tripleTap', NOW_S))
    expect(deliver).toHaveBeenCalledTimes(2)
  })
})
