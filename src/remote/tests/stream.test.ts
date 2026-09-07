// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ listener: undefined as ((event: unknown) => void) | undefined, unsubscribe: vi.fn() }))
vi.mock('../runtime', () => ({
  remoteStatus: () => ({ running: true, lastDetectionAt: null, lastError: null }),
  subscribeRemote: (fn: (event: unknown) => void) => {
    mocks.listener = fn
    return mocks.unsubscribe
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
})
