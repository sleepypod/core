import { normalizeFrame } from '@/src/streaming/normalizeFrame'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoSocket } from '../socket'

interface Message { type: string, [key: string]: unknown }

async function openSocket() {
  const socket = createDemoSocket()
  const messages: Message[] = []
  socket.onmessage = (event: MessageEvent) => messages.push(JSON.parse(event.data as string))
  await vi.waitFor(() => expect(socket.readyState).toBe(1))
  return { socket, messages, ofType: (type: string) => messages.filter(m => m.type === type) }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_DEMO', '1')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('demo sensor socket', () => {
  it('opens, then answers a subscribe with the sensor list and a snapshot', async () => {
    const { socket, messages } = await openSocket()
    socket.send(JSON.stringify({ type: 'subscribe', snapshot: true, sensors: [] }))

    expect(messages[0]).toMatchObject({ type: 'subscribed' })
    const snapshot = messages[1] as unknown as { type: string, latest: Message[], waveform: Message[], range: { min: number, max: number } }
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot.latest.map(f => f.type)).toEqual(expect.arrayContaining(['bedTemp2', 'capSense2', 'frzTemp', 'frzTherm', 'frzHealth', 'log', 'deviceStatus']))
    expect(snapshot.waveform).toHaveLength(10)
    expect(snapshot.range.max).toBeGreaterThan(snapshot.range.min)
    socket.close()
  })

  it('emits firmware-shaped frames the real normalizer understands', async () => {
    const { socket, ofType } = await openSocket()
    vi.useFakeTimers()
    socket.send(JSON.stringify({ type: 'subscribe', sensors: [] }))
    vi.advanceTimersByTime(10_000)

    const piezo = ofType('piezo-dual')[0] as unknown as { freq: number, left1: number[], right1: number[] }
    expect(piezo.freq).toBe(500)
    expect(piezo.left1).toHaveLength(500)
    expect(piezo.right1.every(Number.isInteger)).toBe(true)

    const bed = normalizeFrame(ofType('bedTemp2')[0]) as { leftCenterTemp: number | null, rightInnerTemp: number | null, ambientTemp: number | null }
    expect(bed.leftCenterTemp).toBeGreaterThan(10)
    expect(bed.leftCenterTemp).toBeLessThan(45)
    expect(bed.ambientTemp).toBeCloseTo(21.4)

    const cap = normalizeFrame(ofType('capSense2')[0]) as { left: number[], status: string }
    expect(cap.left).toHaveLength(8)
    expect(cap.status).toBe('good')

    const health = normalizeFrame(ofType('frzHealth')[0]) as { left: { pumpRpm: number } }
    expect(health.left.pumpRpm).toBeGreaterThanOrEqual(0)
    const frz = normalizeFrame(ofType('frzTemp')[0]) as { left: number | null }
    expect(frz.left).toBeGreaterThan(5)
    expect(normalizeFrame(ofType('frzTherm')[0])).toMatchObject({ type: 'frzTherm' })

    expect(ofType('deviceStatus').length).toBeGreaterThanOrEqual(4)
    expect(ofType('log').length).toBeGreaterThan(0)
    socket.close()
  })

  it('serves time ranges, seeks and historical waveforms', async () => {
    const { socket, ofType } = await openSocket()
    vi.useFakeTimers()
    socket.send(JSON.stringify({ type: 'get_time_range' }))
    socket.send(JSON.stringify({ type: 'seek', timestamp: 1_790_000_000 }))
    socket.send(JSON.stringify({ type: 'get_waveform', timestamp: 1_790_000_000, requestId: 7 }))
    vi.advanceTimersByTime(500)

    const range = ofType('time_range')[0] as unknown as { min: number, max: number }
    expect(range.max - range.min).toBe(6 * 3600)
    expect(ofType('seek_complete')).toHaveLength(1)
    const waveform = ofType('waveform')[0] as unknown as { requestId: number, frames: Array<{ ts: number }> }
    expect(waveform.requestId).toBe(7)
    expect(waveform.frames.at(-1)?.ts).toBe(1_790_000_000)
    socket.close()
  })

  it('stops streaming and reports close once closed', async () => {
    const { socket, messages } = await openSocket()
    const onclose = vi.fn()
    socket.onclose = onclose
    vi.useFakeTimers()
    socket.send(JSON.stringify({ type: 'subscribe', sensors: [] }))
    socket.close()
    socket.close()
    const count = messages.length
    vi.advanceTimersByTime(10_000)

    expect(messages).toHaveLength(count)
    expect(socket.readyState).toBe(3)
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it('errors and closes instead of opening when the demo flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO', '')
    const socket = createDemoSocket()
    const onerror = vi.fn()
    socket.onerror = onerror
    await vi.waitFor(() => expect(socket.readyState).toBe(3))
    expect(onerror).toHaveBeenCalled()
    socket.send(JSON.stringify({ type: 'subscribe' }))
  })
})
