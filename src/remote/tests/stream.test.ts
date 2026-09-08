// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ listener: undefined as ((event: unknown) => void) | undefined, unsubscribe: vi.fn(), rawListener: undefined as ((event: Record<string, unknown>) => void) | undefined, unsubscribeRaw: vi.fn() }))
vi.mock('../runtime', () => ({
  remoteStatus: () => ({ running: true, lastDetectionAt: null, lastError: null }),
  subscribeRemote: (fn: (event: unknown) => void) => {
    mocks.listener = fn
    return mocks.unsubscribe
  },
}))
vi.mock('@/src/streaming/piezoStream', () => ({
  onServerFrame: (fn: (event: Record<string, unknown>) => void) => {
    mocks.rawListener = fn
    return mocks.unsubscribeRaw
  },
}))
import { GET } from '../../../app/api/remote/detections/route'
describe('remote detection SSE', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())
  it('streams live events, sends heartbeats and releases its subscriber on abort', async () => {
    const abort = new AbortController()
    const response = GET(new Request('http://localhost/api/remote/detections', { signal: abort.signal }))
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    const reader = response.body?.getReader()
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('"type":"status","running":true')
    mocks.listener?.({ id: 'physical-input' })
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('data: {"id":"physical-input"}\n\n')
    vi.advanceTimersByTime(15000)
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('"type":"status"')
    abort.abort()
    expect((await reader?.read())?.done).toBe(true)
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans up cancelled streams and already-aborted requests', async () => {
    const response = GET(new Request('http://localhost/api/remote/detections'))
    await response.body?.cancel()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
    const abort = new AbortController()
    abort.abort()
    const closed = GET(new Request('http://localhost/api/remote/detections', { signal: abort.signal }))
    expect((await closed.body?.getReader().read())?.done).toBe(true)
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('streams original unknown button evidence only when requested and removes both listeners', async () => {
    const response = GET(new Request('http://localhost/api/remote/detections?raw=1'))
    if (!response.body) throw new Error('Missing stream')
    const reader = response.body.getReader()
    await reader.read()
    const record = { type: 'buttonEvent', left: { extra: 7 }, remoteSource: 'test:1', ts: 1 }
    mocks.rawListener?.({ type: 'piezo-dual', ts: 1 })
    mocks.rawListener?.(record)
    const raw = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6))
    expect(raw).toEqual({ type: 'raw', receivedAt: expect.any(Number), record })
    mocks.rawListener?.({ type: 'log', msg: '[tca8418L] ' + 'x'.repeat(17000) })
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('raw_omitted')
    await reader.cancel()
    expect(mocks.unsubscribeRaw).toHaveBeenCalledOnce()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('disconnects a non-reading client before it can accumulate an unbounded queue', async () => {
    const response = GET(new Request('http://localhost/api/remote/detections'))
    for (let i = 0; i < 16; i++) mocks.listener?.({ id: `event-${i}` })
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    const reader = response.body?.getReader()
    let count = 0
    while (!(await reader?.read())?.done) count++
    expect(count).toBe(16)
  })
})
