import { BUTTONS, INPUTS, type Detection, type Side, type Source } from './model'
export const COMBO_WINDOW_MS = 200 // SleepyPod policy, not a measured firmware constant.
const EDGE_TIMEOUT_MS = 10000
export const HOLD_MS = 1000 // Application policy: holds are observable, not bindable.
const CLICK_WAIT_MS = 1000 // RAW often writes a count before its edge-log payload.
interface Edge {
  counter: number
  ts: number
}
interface Suppression {
  mask: number
  from: number
  until: number
}
interface Group {
  mask: number
  first: number
  last: number
  suppression: Suppression
}
/** Count recognition is firmware-owned. Chords require raw edge evidence (ADR 0024). */
export class RemoteRecognizer {
  private seen = new Set<string>()
  private down: Record<Side, Map<Source, Edge>> = { left: new Map(), right: new Map() }
  private counters: Partial<Record<Side, number>> = {}
  private epochs: Record<Side, number> = { left: 0, right: 0 }
  private stopped = false
  private groups: Partial<Record<Side, Group>> = {}
  private suppression: Record<Side, Suppression[]> = { left: [], right: [] }
  private timers = new Set<ReturnType<typeof setTimeout>>()
  constructor(private emit: (event: Detection) => void, private now = Date.now, private startedAt = now()) {

  }

  stop() {
    this.stopped = true

    for (const timer of this.timers)
      clearTimeout(timer)

    this.timers.clear()

    this.down.left.clear()

    this.down.right.clear()

    this.groups = {}
  }

  private later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)

      fn()
    }, ms)

    this.timers.add(timer)

    return timer
  }

  feed(frame: Record<string, unknown>) {
    if (frame.type === 'remoteReset') {
      this.resetSide('left')
      this.resetSide('right')
      return
    }
    if (this.stopped || (frame.type !== 'buttonEvent' && frame.type !== 'log'))
      return

    const ts = frame.ts

    const source = frame.remoteSource

    // Never act on historical frames replayed on startup/reconnect or undated data.

    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts * 1000 < this.startedAt || ts * 1000 > this.now() + 2000 || this.now() - ts * 1000 > 30000)
      return

    if (typeof source !== 'string' || !source || this.seen.has(source))
      return

    this.seen.add(source)

    if (this.seen.size > 4096)
      this.seen.delete(this.seen.values().next().value ?? '')

    if (frame.type === 'buttonEvent') {
      for (const side of ['left', 'right'] as const) {
        const payload = frame[side]

        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
          continue

        for (const button of BUTTONS) {
          const key = button.id === 'mid' ? 'middle' : button.id

          const count: unknown = (payload as Record<string, unknown>)[key]

          if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0)
            continue

          const gesture = count === 1 ? 'single' : count === 2 ? 'double' : 'unsupported'

          const id = `${button.id}.${count === 1 ? 'single' : count === 2 ? 'double' : `count${count}`}`

          const epoch = this.epochs[side]

          this.later(() => {
            if (epoch !== this.epochs[side])
              return

            const blocked = this.suppression[side].some(s => (s.mask & button.bit) !== 0 && ts * 1000 >= s.from && ts * 1000 <= s.until)

            this.deliver(`${source}:${side}:${id}`, side, button.bit, blocked ? 'unsupported' : gesture, id, ts * 1000, blocked ? 'Consumed by hold or overlapping buttons; no separate click action' : count > 2 ? `Firmware count ${count}; not exposed by the Remote design` : undefined)
          }, CLICK_WAIT_MS)
        }
      }

      return
    }

    const msg = frame.msg

    if (typeof msg !== 'string')
      return

    const sideMatch = /\[tca8418([LR])\]/.exec(msg)

    if (!sideMatch)
      return

    const side: Side = sideMatch[1] === 'L' ? 'left' : 'right'

    if (/init ok|fifo cleared/.test(msg)) {
      this.resetSide(side)

      return
    }

    const match = /-> FW: (\d+) \[tca8418[LR]\] gpi (press|release) (97|98|99)$/.exec(msg)

    if (!match)
      return

    const counter = Number(match[1])

    if (!Number.isSafeInteger(counter))
      return

    if (this.counters[side] !== undefined && counter < (this.counters[side] ?? counter))
      this.resetSide(side)

    this.counters[side] = counter

    const button = BUTTONS[Number(match[3]) - 97]

    const held = this.down[side]

    if ([...held.values()].some(edge => counter - edge.counter > EDGE_TIMEOUT_MS))
      this.resetSide(side)

    this.counters[side] = counter

    this.suppression[side] = this.suppression[side].filter(s => s.until >= this.now() - 30000)

    if (match[2] === 'release') {
      const edge = held.get(button.id)

      if (!edge)
        return

      held.delete(button.id)

      const group = this.groups[side]

      if (group) {
        if (held.size)
          return

        group.suppression.until = ts * 1000 + 1000

        this.groups[side] = undefined

        const active = BUTTONS.filter(b => (b.bit & group.mask) !== 0)

        const inputId = `${active.map(b => b.id).join('+')}.single`

        const supported = active.length === 2 && group.last - group.first <= COMBO_WINDOW_MS && INPUTS.includes(inputId as typeof INPUTS[number])

        this.deliver(`${source}:${side}:edges`, side, group.mask, supported ? 'combo' : 'unsupported', inputId, ts * 1000, supported ? 'Experimental: complete overlapping edge sequence' : active.length === 3 ? 'All-three input is not exposed' : 'Held-button sequence is not exposed')
      }
      else if (counter - edge.counter >= HOLD_MS) {
        this.suppression[side].push({ mask: button.bit, from: edge.ts, until: ts * 1000 + 1000 })

        this.deliver(`${source}:${side}:hold`, side, button.bit, 'unsupported', `${button.id}.hold`, ts * 1000, `Hold (${counter - edge.counter} cover ticks); not exposed`)
      }

      return
    }

    if (held.has(button.id))
      return

    held.set(button.id, { counter, ts: ts * 1000 })

    const previous = this.groups[side]

    if (previous) {
      previous.mask |= button.bit

      previous.suppression.mask |= button.bit

      previous.last = counter

      this.deliver(`${source}:${side}:onset`, side, previous.mask, 'unsupported', 'overlap.pending', ts * 1000, 'Overlapping buttons; awaiting complete release sequence')

      return
    }

    if (held.size < 2)
      return

    const active = BUTTONS.filter(b => held.has(b.id))

    const mask = active.reduce((n, b) => n | b.bit, 0)

    const first = Math.min(...[...held.values()].map(e => e.counter))

    const from = Math.min(...[...held.values()].map(e => e.ts))

    const suppression = { mask, from, until: from + EDGE_TIMEOUT_MS + 2000 }

    this.suppression[side].push(suppression)

    this.groups[side] = { mask, first, last: counter, suppression }

    this.deliver(`${source}:${side}:onset`, side, mask, 'unsupported', `${active.map(b => b.id).join('+')}.pending`, ts * 1000, 'Overlapping buttons; awaiting complete release sequence')
  }

  private resetSide(side: Side) {
    this.epochs[side]++

    this.down[side].clear()

    this.groups[side] = undefined

    this.counters[side] = undefined
  }

  private deliver(id: string, side: Side, mask: number, gesture: Detection['gesture'], inputId: string, t: number, detail?: string) {
    this.emit({ id, side, mask, gesture, inputId, t, receivedAt: this.now(), latencyMs: null, detail })
  }
}
