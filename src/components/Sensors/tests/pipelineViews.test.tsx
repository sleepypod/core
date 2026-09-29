import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
import { DataPipeline } from '../DataPipeline'
import { StreamsCard } from '../StreamsCard'
import { PipelineTab } from '../PipelineTab'
import { EventTimeline } from '../EventTimeline'

const mock = vi.hoisted(() => ({ callbacks: [] as Array<(f: SensorFrame) => void>, width: (_entries: unknown) => {
  void _entries
}, disconnect: vi.fn() }))
vi.mock('@/src/hooks/useSensorStream', () => ({ useOnSensorFrame: (cb: (f: SensorFrame) => void) => {
  mock.callbacks.push(cb)
} }))
vi.mock('@xyflow/react', () => ({
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }, MarkerType: { ArrowClosed: 'arrow' }, Handle: () => null,
  ReactFlow: ({ nodes, edges, nodeTypes }: { nodes: Array<{ id: string, data: { label: string, sub: string, color: string } }>, edges: Array<{ id: string, source: string, target: string }>, nodeTypes: { pipeline: ComponentType<{ data: { label: string, sub: string, color: string } }> } }) => (
    <div data-testid="dag">
      {nodes.map(n => <nodeTypes.pipeline key={n.id} data={n.data} />)}
      {edges.map(e => (
        <span key={e.id}>
          {e.source}
          {' '}
          →
          {' '}
          {e.target}
        </span>
      ))}
    </div>
  ),
}))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  mock.callbacks = []
})

it('switches from unmeasured to phone stages to the desktop read/write graph and disconnects', () => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: typeof mock.width) {
      mock.width = cb
    }

    observe() {}
    disconnect = mock.disconnect
  })
  const { unmount } = render(<DataPipeline action={<button>Inspect</button>} />)
  expect(screen.queryByText('Firmware')).toBeNull()
  act(() => mock.width([{ contentRect: { width: 400 } }]))
  expect(screen.getByText('Firmware')).toBeTruthy()
  expect(screen.queryByTestId('dag')).toBeNull()
  act(() => mock.width([{ contentRect: { width: 900 } }]))
  expect(screen.getByTestId('dag').textContent).toContain('browser → trpc')
  expect(screen.getByText('RAW Files')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Inspect' })).toBeTruthy()
  unmount()
  expect(mock.disconnect).toHaveBeenCalledOnce()
})

it('counts grouped frames over a trailing minute while retaining their last-seen age', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-29T00:00:00Z'))
  const { unmount } = render(<StreamsCard />)
  const emit = mock.callbacks[0]
  expect(screen.getByTestId('stream-piezo').textContent).toContain('0—')
  act(() => {
    for (const type of ['lps', 'piezo-dual', 'unknown']) emit({ type } as SensorFrame)
    vi.advanceTimersByTime(1000)
  })
  expect(screen.getByTestId('stream-piezo').textContent).toContain('piezo-dual21.0s')
  act(() => vi.advanceTimersByTime(60000))
  expect(screen.getByTestId('stream-piezo').textContent).toContain('piezo-dual01m')
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds event history, ignores unknown frames and expires old ticks', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-29T00:00:00Z'))
  const { unmount } = render(<EventTimeline />)
  const emit = mock.callbacks[0]
  act(() => {
    emit({ type: 'unknown' } as unknown as SensorFrame)
    for (let i = 0; i < 1201; i++) emit({ type: 'lps' } as SensorFrame)
    vi.advanceTimersByTime(500)
  })
  expect(screen.getByTestId('lane-PZO').children).toHaveLength(1200)
  expect(screen.getByTestId('lane-STS').children).toHaveLength(0)
  act(() => vi.advanceTimersByTime(60000))
  expect(screen.getByTestId('lane-PZO').children).toHaveLength(0)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('composes the pipeline graph, live rates, timeline and raw-frame inspector', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  render(<PipelineTab />)
  expect(screen.getByTestId('stream-piezo')).toBeTruthy()
  expect(screen.getByTestId('lane-PZO')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Raw frames/i })).toBeTruthy()
})
