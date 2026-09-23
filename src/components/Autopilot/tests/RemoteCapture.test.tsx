import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig } from '@/src/remote/model'
import { RemoteCapture } from '../RemoteCapture'

class FakeSource {
  static latest: FakeSource
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  onopen?: () => void
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
  it('shows right-side combos while mapping loads and explains unsupported gestures', () => {
    render(<RemoteCapture config={undefined} automations={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }))
    act(() => {
      FakeSource.latest.message({ ...detection('combo'), side: 'right', mask: 5, gesture: 'combo', inputId: 'top+bottom.single' })
      FakeSource.latest.message({ ...detection('hold'), gesture: 'unsupported', inputId: 'top.hold', detail: 'Hold is diagnostic only' })
    })
    expect(screen.getByText('R')).toBeTruthy()
    expect(screen.getByText('combo')).toBeTruthy()
    expect(screen.getByText('Loading mapping…')).toBeTruthy()
    expect(screen.getByText('Hold is diagnostic only')).toBeTruthy()
  })
  it('arms a real stream URL, resolves retained events from the latest mapping, and closes on stop', () => {
    const { rerender } = render(<RemoteCapture config={emptyConfig()} automations={[]} />)
    expect(screen.getByText('Arm capture to inspect real button inputs.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }))
    const source = FakeSource.latest
    expect(source.url).toBe('/api/remote/detections?raw=1')
    act(() => {
      source.message({ type: 'status', running: true })
      source.message(detection('one'))
    })
    expect(screen.getByText('Firmware default')).toBeTruthy()
    rerender(<RemoteCapture config={{ ...emptyConfig(), left: { 'top.single': { action: 'temp.up', deltaF: 2 } } }} automations={[]} />)
    expect(screen.getByText('Temperature up 2°F')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop capture' }))
    expect(source.close).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Temperature up 2°F')).toBeTruthy()
  })
  it('keeps listening for distinct presses, clears without stopping, and can reconnect or re-arm', () => {
    render(<RemoteCapture config={emptyConfig()} automations={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }))
    const first = FakeSource.latest
    act(() => {
      first.message(detection('one'))
      first.message({ ...detection('two'), inputId: 'mid.single', mask: 2 })
      first.message({ ...detection('three'), inputId: 'bottom.single', mask: 1 })
      first.message(detection('four'))
    })
    expect(screen.getAllByRole('row')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(first.close).not.toHaveBeenCalled()
    expect(screen.getAllByRole('row')).toHaveLength(2)
    act(() => first.message(detection('five')))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    const second = FakeSource.latest
    expect(second).not.toBe(first)
    expect(first.close).toHaveBeenCalledOnce()
    act(() => {
      first.message(detection('stale'))
      second.onopen?.()
      second.message(detection('six'))
    })
    expect(screen.getAllByRole('row')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Stop capture' }))
    expect(second.close).toHaveBeenCalledOnce()
    act(() => second.message(detection('stopped')))
    expect(screen.getAllByRole('row')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }))
    act(() => FakeSource.latest.message(detection('seven')))
    expect(screen.getAllByRole('row')).toHaveLength(4)
  })
  it('downloads original evidence even when no gesture is recognized', async () => {
    const create = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:capture')
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<RemoteCapture config={emptyConfig()} automations={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Arm capture' }))
    const record = { type: 'log', ts: 123, msg: '[tca8418R] gpi press 105', remoteSource: 'raw:5' }
    act(() => FakeSource.latest.message({ type: 'raw', receivedAt: 124, record }))
    expect(screen.queryByText('Invalid detection received')).toBeNull()
    fireEvent.change(screen.getByLabelText('Cover / firmware and test notes'), { target: { value: 'cover B, top once' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop capture' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download capture' }))
    expect(click).toHaveBeenCalledOnce()
    const blob = create.mock.calls[0][0] as Blob
    const exported = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blob)
    })
    expect(exported).toContain('cover B, top once')
    expect(exported).toContain(JSON.stringify(record))
    expect(exported).toContain('connection_stop')
    click.mockRestore()
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
