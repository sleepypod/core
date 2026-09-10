// @vitest-environment node
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteRecognizer } from '../recognizer'
import type { Detection } from '../model'
describe('remote recognition from observed signals', () => {
  let events: Detection[]

  let recognizer: RemoteRecognizer

  let sequence: number

  const start = 1788768700000

  beforeEach(() => {
    vi.useFakeTimers()

    vi.setSystemTime(start)

    events = []

    sequence = 0

    recognizer = new RemoteRecognizer(event => events.push(event))
  })

  afterEach(() => {
    recognizer.stop()

    vi.useRealTimers()
  })

  function feed(record: Record<string, unknown>) {
    recognizer.feed({ ts: Math.floor(Date.now() / 1000), remoteSource: `test:${sequence++}`, ...record })
  }

  function edge(counter: number, operation: 'press' | 'release', code: number, side = 'L') {
    feed({ type: 'log', msg: `Sensor.cpp:614 handleCommand|[sensor] -> FW: ${counter} [tca8418${side}] gpi ${operation} ${code}` })
  }

  it('replays the labeled September 7 trial in actual receipt order', () => {
    const fixture = readFileSync(new URL('../../../docs/hardware/evidence/cover-buttons-20260907.ndjson', import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))

    for (const row of fixture) {
      const receivedAt = Math.ceil(row.received_at * 1000)

      vi.advanceTimersByTime(Math.max(0, receivedAt - Date.now()))

      recognizer.feed({ ...row.record, remoteSource: `${row.file}:${row.offset_start}:${row.item_index}` })
    }

    vi.advanceTimersByTime(1001)

    expect(events.filter(e => e.gesture === 'combo').map(e => e.inputId)).toEqual(['top+mid.single', 'mid+bottom.single'])

    for (const count of [3, 4, 5])
      expect(events).toContainEqual(expect.objectContaining({ inputId: `top.count${count}`, gesture: 'unsupported', detail: expect.stringContaining(`Firmware count ${count}`) }))

    expect(events).toContainEqual(expect.objectContaining({ inputId: 'mid.hold', detail: expect.stringContaining('3136') }))

    expect(events).toContainEqual(expect.objectContaining({ inputId: 'top+bottom.single', gesture: 'unsupported', detail: 'Held-button sequence is not exposed' }))

    expect(events).toContainEqual(expect.objectContaining({ mask: 7, gesture: 'unsupported' }))

    // A mixed overlap + later top click must not accidentally dispatch a double binding.

    expect(events.filter(e => e.gesture === 'double')).toEqual([])

    expect(events.every(e => e.latencyMs === null)).toBe(true)
  })

  it('preserves native double counts, validates counts, and deduplicates replay', () => {
    const frame = { type: 'buttonEvent', ts: start / 1000, remoteSource: 'file:10:0', left: { top: 2, middle: 0, bottom: -1 }, right: { top: 1.5 } }

    recognizer.feed(frame)

    recognizer.feed(frame)

    vi.advanceTimersByTime(1000)

    expect(events).toHaveLength(1)

    expect(events[0]).toMatchObject({ side: 'left', inputId: 'top.double', gesture: 'double' })
  })

  it('rejects fresh button counts without a usable source identity', () => {
    for (const remoteSource of [undefined, '', 42])
      recognizer.feed({ type: 'buttonEvent', ts: start / 1000, remoteSource, left: { top: 1 } })
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([])
  })

  it.each(['transport', 'fifo', 'counter'] as const)('clears old combo suppression after a %s reset', (reset) => {
    edge(100, 'press', 97)
    edge(116, 'press', 98)
    if (reset === 'transport') recognizer.feed({ type: 'remoteReset' })
    else if (reset === 'fifo') feed({ type: 'log', msg: '[tca8418L] fifo cleared' })
    else edge(1, 'press', 97)
    feed({ type: 'buttonEvent', left: { top: 1 } })
    vi.advanceTimersByTime(1000)
    expect(events.at(-1)).toMatchObject({ side: 'left', inputId: 'top.single', gesture: 'single' })
    expect(events.filter(e => e.gesture === 'combo')).toEqual([])
  })

  it('recognizes right-side combos independently and ignores repeated same-counter presses', () => {
    edge(100, 'press', 97, 'R')
    edge(100, 'press', 97, 'R')
    edge(116, 'press', 99, 'R')
    edge(200, 'release', 97, 'R')
    edge(220, 'release', 99, 'R')
    feed({ type: 'buttonEvent', right: { top: 1, bottom: 1 }, left: { top: 1 } })
    vi.advanceTimersByTime(1000)
    expect(events.filter(e => e.gesture === 'combo')).toEqual([
      expect.objectContaining({ side: 'right', inputId: 'top+bottom.single' }),
    ])
    expect(events.filter(e => e.gesture === 'single')).toEqual([
      expect.objectContaining({ side: 'left', inputId: 'top.single' }),
    ])
  })

  it('waits for both releases, suppresses constituent counts, then permits a later click', () => {
    edge(100, 'press', 98)

    edge(116, 'press', 99)

    vi.advanceTimersByTime(1100)

    expect(events.some(e => e.gesture === 'combo')).toBe(false)

    edge(276, 'release', 99)

    edge(308, 'release', 98)

    feed({ type: 'buttonEvent', left: { middle: 1, bottom: 1 } })

    vi.advanceTimersByTime(1000)

    expect(events.filter(e => e.gesture === 'combo')).toHaveLength(1)

    expect(events.find(e => e.gesture === 'combo')).toMatchObject({ mask: 3, inputId: 'mid+bottom.single' })

    expect(events.some(e => e.gesture === 'single')).toBe(false)

    vi.advanceTimersByTime(2000)

    feed({ type: 'buttonEvent', left: { bottom: 1 } })

    vi.advanceTimersByTime(1000)

    expect(events.at(-1)).toMatchObject({ inputId: 'bottom.single', gesture: 'single' })
  })

  it('does not dispatch incomplete or three-button combinations', () => {
    edge(100, 'press', 97)

    edge(132, 'press', 99)

    edge(148, 'press', 98)

    edge(3140, 'release', 98)

    edge(3172, 'release', 97)

    vi.advanceTimersByTime(12000)

    edge(13000, 'press', 98)

    edge(13100, 'release', 98)

    expect(events.some(e => e.gesture === 'combo')).toBe(false)
  })
  it('does not use a later gesture to finish a combo whose release was lost', () => {
    edge(100, 'press', 97)
    edge(130, 'press', 99)
    edge(200, 'release', 97)
    // Bottom's release was lost. A new bottom press is fresh input, not a
    // duplicate of the old down edge; its release cannot complete that combo.
    edge(1500, 'press', 99)
    edge(1650, 'release', 99)
    expect(events.some(e => e.gesture === 'combo')).toBe(false)
  })

  it('cancels queued clicks on keypad reset, ignores recovery artifacts and old frames, and stops permanently', () => {
    feed({ type: 'buttonEvent', left: { top: 1 } })

    feed({ type: 'log', msg: '-> FW: 300 [tca8418L] event fifo cleared, returning to normal mode' })

    edge(300, 'press', 105)

    edge(300, 'press', 127)

    feed({ type: 'buttonEvent', ts: start / 1000 - 1, left: { top: 1 } })

    vi.advanceTimersByTime(1000)

    expect(events).toEqual([])

    feed({ type: 'buttonEvent', left: { top: 1 } })

    recognizer.stop()

    feed({ type: 'buttonEvent', left: { top: 1 } })

    vi.advanceTimersByTime(1000)

    expect(events).toEqual([])
  })
  it('invalidates pending input on transport gaps and firmware counter regression', () => {
    feed({ type: 'buttonEvent', left: { top: 1 } })
    recognizer.feed({ type: 'remoteReset' })
    edge(1000, 'press', 97)
    edge(10, 'press', 99)
    edge(50, 'release', 99)
    edge(100, 'release', 97)
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([])
  })
  it('ignores malformed edge records and unrelated log payloads', () => {
    feed({ type: 'log', msg: null })
    feed({ type: 'log', msg: 'ordinary firmware message' })
    feed({ type: 'log', msg: '-> FW: 9007199254740993 [tca8418L] gpi press 97' })
    edge(20, 'release', 97)
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([])
  })
  it('does not convert a hold longer than the stale-edge limit into a single action', () => {
    edge(100, 'press', 98)
    vi.advanceTimersByTime(12000)
    edge(12100, 'release', 98)
    feed({ type: 'buttonEvent', left: { middle: 1 } })
    vi.advanceTimersByTime(1000)
    expect(events.at(-1)).toMatchObject({ inputId: 'mid.single', gesture: 'unsupported' })
  })
  it('does not evict still-actionable identities when deduplication capacity is reached', () => {
    const frame = { type: 'buttonEvent', ts: start / 1000, remoteSource: 'original', left: { top: 1 } }
    recognizer.feed(frame)
    vi.advanceTimersByTime(1000)
    for (let i = 0; i < 4100; i++) feed({ type: 'log', msg: 'ordinary log' })
    recognizer.feed(frame)
    vi.advanceTimersByTime(1000)
    expect(events).toHaveLength(1)
    vi.advanceTimersByTime(31000)
    feed({ type: 'buttonEvent', left: { top: 1 } })
    vi.advanceTimersByTime(1000)
    expect(events).toHaveLength(2)
  })
})
