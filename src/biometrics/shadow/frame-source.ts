import { shadowFrameBudgetsSchema as budgetsSchema } from './execution-policy'
import { z } from 'zod'
import { subscribeProspectiveFrames } from '../../streaming/prospectiveFrameTap'
import { mechanicalSnapshotSchema } from '../mechanical/snapshot'

const contextSchema = z.object({ activeSides: z.array(z.enum(['left', 'right'])).max(2).nullable(),
  leftOccupied: z.boolean().nullable(), rightOccupied: z.boolean().nullable(), pumpContextKnown: z.boolean(),
  mechanical: mechanicalSnapshotSchema.nullable().optional(),
}).strict().refine(value => value.activeSides === null || new Set(value.activeSides).size === value.activeSides.length, 'Duplicate active side')
const pumpKeys = ['pumpRpm', 'pump_rpm', 'pumpRPM', 'rpm', 'pumpDuty', 'pump_duty', 'duty'] as const
function pumpValue(value: unknown) {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 32 && value.trim() !== '' && Number.isFinite(Number(value))) return value
  throw new Error('Invalid prospective pump context')
}
function pumpSide(raw: unknown) {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid prospective pump side')
  const source = raw as Record<string, unknown>, result: Record<string, unknown> = {}
  for (const key of pumpKeys) if (source[key] !== undefined) result[key] = pumpValue(source[key])
  if (source.pump !== undefined) {
    if (!source.pump || typeof source.pump !== 'object' || Array.isArray(source.pump)) throw new Error('Invalid prospective nested pump')
    const pump = source.pump as Record<string, unknown>, selected: Record<string, unknown> = {}
    for (const key of ['rpm', 'duty', 'power']) if (pump[key] !== undefined) selected[key] = pumpValue(pump[key])
    result.pump = selected
  }
  return result
}
function channel(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 5000) throw new Error('Invalid prospective waveform channel')
  const bytes = Buffer.alloc(raw.length * 4)
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index]
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error('Invalid prospective waveform sample')
    bytes.writeInt32LE(value, index * 4)
  }
  return bytes.toString('base64')
}
function record(frame: Record<string, unknown>) {
  const result: Record<string, unknown> = { type: frame.type }
  if (frame.ts !== undefined) result.ts = z.number().finite().nonnegative().parse(frame.ts)
  if (frame.type === 'piezo-dual') {
    if (frame.freq !== undefined) result.freq = z.literal(500).parse(frame.freq)
    result.left1 = channel(frame.left1)
    result.right1 = channel(frame.right1)
  }
  else {
    const left = pumpSide(frame.left), right = pumpSide(frame.right)
    if (left !== undefined) result.left = left
    if (right !== undefined) result.right = right
  }
  return result
}

/** Subscribes to actual live decoded frames. Overflow fails the attempt rather
 * than silently dropping evidence or allowing the worker to lag without bound.
 * Returned JSON is a private snapshot; raw stream objects are never retained. */
export function openShadowFrameSource(options: {
  startMs: number
  endMs: number
  signal: AbortSignal
  budgets: z.infer<typeof budgetsSchema>
  context: (frame: Record<string, unknown>, observedAtMs: number) => unknown
  fail: () => void
}) {
  const budgets = budgetsSchema.parse(options.budgets)
  if (!Number.isSafeInteger(options.startMs) || !Number.isSafeInteger(options.endMs) || options.startMs < 0 || options.endMs <= options.startMs || options.endMs - options.startMs > 7 * 86400000 || options.endMs - Date.now() > 7 * 86400000) throw new Error('Invalid prospective source window')
  let closed = false, used = false, bytes = 0, previousArrival = options.startMs
  const queue: { text: string, bytes: number }[] = []
  let waiter: ((value: IteratorResult<unknown>) => void) | undefined
  let unsubscribe: (() => void) | undefined
  const close = () => {
    if (closed) return
    closed = true
    unsubscribe?.()
    options.signal.removeEventListener('abort', close)
    clearTimeout(endTimer)
    queue.length = 0
    bytes = 0
    waiter?.({ done: true, value: undefined })
    waiter = undefined
  }
  const notifyFailure = () => {
    try {
      options.fail()
    }
    catch { /* Isolate consumer errors from the live server's timers. */ }
  }
  const finishCollection = () => {
    const lost = queue.length > 0
    close()
    if (lost) notifyFailure()
  }
  const endTimer = setTimeout(finishCollection, Math.max(0, options.endMs - Date.now()))
  if (options.signal.aborted) close()
  else {
    options.signal.addEventListener('abort', close, { once: true })
    try {
      unsubscribe = subscribeProspectiveFrames({ failed: () => {
        close()
        notifyFailure()
      }, frame: (frame, observedAtMs) => {
        if (closed) return
        if (!Number.isSafeInteger(observedAtMs) || observedAtMs > Date.now()) throw new Error('Invalid prospective arrival clock')
        if (observedAtMs < options.startMs || observedAtMs >= options.endMs) return
        if (observedAtMs < previousArrival) throw new Error('Prospective arrival clock regressed')
        const eventMs = z.number().finite().nonnegative().parse(frame.ts) * 1000
        if (!Number.isFinite(eventMs) || eventMs > Number.MAX_SAFE_INTEGER || observedAtMs - eventMs > budgets.maximumEventAgeMs || eventMs - observedAtMs > budgets.maximumFutureSkewMs) throw new Error('Prospective event time outside freshness policy')
        if (queue.length >= budgets.maximumFrames) throw new Error('Prospective frame queue full')
        const value = { type: 'frame', observedAtMs, record: record(frame), context: contextSchema.parse(options.context(frame, observedAtMs)) }
        const text = JSON.stringify(value), size = Buffer.byteLength(text)
        if (size > 128 * 1024 || bytes + size > budgets.maximumBytes) throw new Error('Prospective frame byte quota exceeded')
        previousArrival = observedAtMs
        if (waiter) {
          const resolve = waiter
          waiter = undefined
          resolve({ done: false, value: JSON.parse(text) })
        }
        else {
          queue.push({ text, bytes: size })
          bytes += size
        }
      } })
    }
    catch (error) {
      close()
      throw error
    }
  }
  return { close, frames: { [Symbol.asyncIterator]() {
    if (used) throw new Error('Prospective frame source has one consumer')
    used = true
    return { next: (): Promise<IteratorResult<unknown>> => {
      if (closed) return Promise.resolve({ done: true, value: undefined })
      if (waiter) return Promise.reject(new Error('Concurrent prospective frame reads'))
      const row = queue.shift()
      if (row) {
        bytes -= row.bytes
        return Promise.resolve({ done: false, value: JSON.parse(row.text) })
      }
      return new Promise((resolve) => {
        waiter = resolve
      })
    }, return: async (): Promise<IteratorResult<unknown>> => {
      if (Date.now() >= options.endMs) finishCollection()
      else close()
      return { done: true, value: undefined }
    } }
  } } }
}
