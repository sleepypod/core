import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig } from '@/src/remote/model'
import { RemoteCapture } from '../RemoteCapture'

class FakeSource {
  static latest: FakeSource
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  close = vi.fn()
  constructor(public url: string) { FakeSource.latest = this }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
beforeEach(() => vi.stubGlobal('EventSource', FakeSource))
afterEach(() => {
  cleanup()

  vi.unstubAllGlobals()
})
const detection = (id: string) => ({ id, side: 'left', mask: 4, gesture: 'single', inputId: 'top.single', t: 1788768700000, receivedAt: 1788768701000, latencyMs: null })

describe('live Remote capture', () => {
  it('arms a real stream URL, resolves retained events from the latest mapping, and closes on stop', () => {
    const { rerender } = render(<RemoteCapture config={emptyConfig()} automations={[]} />)
    expect(screen.getByText('Arm capture to inspect real button inputs.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }))
    const source = FakeSource.latest
    expect(source.url).toBe('/api/remote/detections')
    act(() => {
      source.message({ type: 'status', running: true })
      source.message(detection('one'))
    })
    expect(screen.getByText('Firmware default')).toBeTruthy()
    rerender(<RemoteCapture config={{ ...emptyConfig(), left: { 'top.single': { action: 'temp.up', deltaF: 2 } } }} automations={[]} />)
    expect(screen.getByText('Temperature up 2°F')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(source.close).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Temperature up 2°F')).toBeTruthy()
  })
  it('retains at most 12 unique detections and replaces outcome updates', () => {
    render(<RemoteCapture config={emptyConfig()} automations={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }))
    act(() => {
      for (let i = 0; i < 15; i++) FakeSource.latest.message({ ...detection(`${i}`), inputId: `input-${i}` })
      FakeSource.latest.message({ ...detection('14'), inputId: 'input-14', outcome: 'Completed' })
    })
    expect(screen.getAllByRole('row')).toHaveLength(13)
    expect(screen.queryByText('input-2')).toBeNull()
    expect(screen.getAllByText('input-14')).toHaveLength(1)
    expect(screen.getByText('Completed')).toBeTruthy()
  })
  it('reports unavailable transport and malformed messages without rendering unsafe detections', () => {
    render(<RemoteCapture config={emptyConfig()} automations={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }))
    act(() => FakeSource.latest.message({ type: 'status', running: false }))
    expect(screen.getByText(/Device listener unavailable/)).toBeTruthy()
    act(() => FakeSource.latest.message({ ...detection('bad'), mask: null }))
    expect(screen.getByText(/Invalid detection received/)).toBeTruthy()
    expect(screen.queryByText('top.single')).toBeNull()
    act(() => FakeSource.latest.onerror?.())
    expect(screen.getByText(/Disconnected — reconnecting/)).toBeTruthy()
    act(() => FakeSource.latest.onmessage?.({ data: '{broken' }))
    expect(screen.getByText(/Invalid detection received/)).toBeTruthy()
  })
})
