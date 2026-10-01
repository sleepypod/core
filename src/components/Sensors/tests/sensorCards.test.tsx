import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
import { BedTempMatrix } from '../BedTempMatrix'
import { FreezerHealthCard } from '../FreezerHealthCard'
import { PresenceCard } from '../PresenceCard'
import { FlowrateChart } from '../FlowrateChart'
import { RawFrameDrawer } from '../RawFrameDrawer'
import { FirmwareLogConsole } from '../FirmwareLogConsole'
import { EnvironmentInfoPanel } from '@/src/components/EnvironmentInfo/EnvironmentInfoPanel'
const mock = vi.hoisted(() => ({ frames: {} as Record<string, unknown>, data: {} as Record<string, unknown>, loading: false, error: null as Error | null, frame: (_f: SensorFrame) => {
  void _f
}, query: vi.fn() }))
vi.mock('@/src/hooks/useSensorStream', () => ({ useSensorFrame: (type: string) => mock.frames[type], useOnSensorFrame: (cb: typeof mock.frame) => {
  mock.frame = cb
} }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'C' }) }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ sideName: (s: string) => s }) }))
vi.mock('@/src/utils/trpc', () => {
  const query = (key: string) => ({ useQuery: (input: unknown) => {
    mock.query(key, input)
    return { data: mock.data[key], isLoading: mock.loading, isError: !!mock.error, error: mock.error }
  } })
  return { trpc: {
    environment: { getLatestBedTemp: query('bed'), getLatestFreezerTemp: query('freezer'), getLatestAmbientLight: query('light') },
    waterLevel: { getLatest: query('water'), getFlowReadings: query('flow') }, biometrics: { getOccupancy: query('occupancy') },
  } }
})
beforeEach(() => {
  mock.frames = {}
  mock.data = {}
  mock.loading = false
  mock.error = null
  vi.clearAllMocks()
})
const emit = (frame: object) => act(() => mock.frame(frame as SensorFrame))
const bed = { leftOuterTemp: 24, leftCenterTemp: 25, leftInnerTemp: 26, rightOuterTemp: 27, rightCenterTemp: 28, rightInnerTemp: 29, ambientTemp: 20, mcuTemp: 30, humidity: 45.2 }

it('prefers live bed temperatures to stored data and handles absent readings', () => {
  const { rerender } = render(<BedTempMatrix />)
  expect(screen.getByText('Waiting for temperature data')).toBeTruthy()
  mock.loading = true
  rerender(<BedTempMatrix />)
  expect(screen.queryByText('Waiting for temperature data')).toBeNull()
  mock.loading = false
  mock.data.bed = bed
  rerender(<BedTempMatrix />)
  expect(screen.getByText('stored')).toBeTruthy()
  expect(screen.getByTitle('L ctr').textContent).toBe('25.0°')
  mock.frames.bedTemp2 = { ...bed, leftCenterTemp: 31, humidity: null }
  rerender(<BedTempMatrix />)
  expect(screen.queryByText('stored')).toBeNull()
  expect(screen.getByTitle('L ctr').textContent).toBe('31.0°')
})

it('shows stored and live freezer readings, water warnings and pump RPM', () => {
  const { rerender } = render(<FreezerHealthCard />)
  expect(screen.getAllByText('No data')).toHaveLength(2)
  mock.data.freezer = { leftWaterTemp: 25, rightWaterTemp: null, heatsinkTemp: 30 }
  mock.data.water = { level: 'low' }
  rerender(<FreezerHealthCard />)
  expect(screen.getByText('stored')).toBeTruthy()
  expect(screen.getAllByText('Water low')).toHaveLength(2)
  mock.frames = { frzTemp: { left: 24, right: 26, amb: 20, hs: 30 }, frzTherm: { left: 1, right: 2 }, frzHealth: { left: { tecCurrent: 1, pumpRpm: 0, flowrate: null }, right: { tecCurrent: 2, pumpRpm: 2400, flowrate: 2 }, fan: { rpm: 200 } } }
  mock.data.water = { level: 'ok' }
  rerender(<FreezerHealthCard />)
  expect(screen.getAllByText('Normal')).toHaveLength(2)
  expect(screen.getByText('2,400')).toBeTruthy()
  expect(screen.getByText(/therm 1.0\/2.0/)).toBeTruthy()
})

it('uses server occupancy while visualizing frame variance independently', () => {
  const { rerender } = render(<PresenceCard />)
  expect(screen.getByTestId('presence-left').textContent).toContain('left · --')
  mock.data.occupancy = { left: { occupied: true, available: true, movement: { active: true } }, right: { occupied: false, available: false, movement: { active: false } } }
  mock.frames.capSense2 = { ts: Date.now() }
  rerender(<PresenceCard />)
  emit({ type: 'log' })
  emit({ type: 'capSense', left: 0, right: 0 })
  emit({ type: 'capSense2', left: [1, 2, 3, 4, 5, 6], right: [0, 0, 0, 0, 0, 0] })
  expect(screen.getByTestId('presence-left').textContent).toContain('in bedmoving')
  expect(screen.getByTestId('presence-right').textContent).toContain('emptysensor n/a')
  expect(screen.getByLabelText('left zone activity').querySelector<HTMLElement>('[data-zone="head"]')?.style.height).toBe('100%')
})

it('switches flow units and ranges with live readings and downsampled history', () => {
  const { rerender } = render(<FlowrateChart />)
  expect(screen.getByText('No flow history')).toBeTruthy()
  mock.frames.frzHealth = { left: { flowrate: 1.23, pumpRpm: 2300 }, right: { flowrate: null, pumpRpm: 0 } }
  mock.data.flow = Array.from({ length: 241 }, (_, i) => ({ timestamp: new Date(i * 60000), leftFlowrateCd: i % 2 ? null : 123, rightFlowrateCd: 100, leftPumpRpm: 2300, rightPumpRpm: null }))
  rerender(<FlowrateChart />)
  expect(screen.getByText('1.23')).toBeTruthy()
  // Hover reads the time and both sides' values; a missing left sample drops just that value.
  const box = screen.getByText('Left · flow').closest('.grid')?.nextElementSibling as HTMLElement
  vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 56, right: 300, bottom: 56, toJSON: () => ({}) })
  fireEvent.pointerMove(box, { clientX: 0, clientY: 10 })
  expect(screen.getByTestId('chart-hover').textContent).toMatch(/^\d{1,2}:\d\d [AP]M · 1\.23 \/ 1\.00$/)
  fireEvent.pointerLeave(box)
  fireEvent.click(screen.getByRole('tab', { name: 'RPM' }))
  expect(screen.getByText('2,300')).toBeTruthy()
  fireEvent.pointerMove(box, { clientX: 0, clientY: 10 })
  expect(screen.getByTestId('chart-hover').textContent).toMatch(/^\d{1,2}:\d\d [AP]M · 2,300$/)
  fireEvent.pointerLeave(box)
  fireEvent.change(screen.getByLabelText('Flow history range'), { target: { value: '24' } })
  expect(mock.query).toHaveBeenLastCalledWith('flow', { hours: 24 })
  mock.error = new Error('Offline')
  rerender(<FlowrateChart />)
  expect(screen.getByText('Failed to load flow data')).toBeTruthy()
  mock.loading = true
  rerender(<FlowrateChart />)
  expect(screen.queryByText('Failed to load flow data')).toBeNull()
})

it('shows side-specific room averages and query failures', () => {
  const { rerender } = render(<EnvironmentInfoPanel side="left" unit="C" />)
  mock.data.bed = bed
  rerender(<EnvironmentInfoPanel side="left" unit="C" />)
  expect(screen.getByText('25.0°')).toBeTruthy()
  expect(screen.getByText('45%')).toBeTruthy()
  rerender(<EnvironmentInfoPanel side="right" unit="C" />)
  expect(screen.getByText('28.0°')).toBeTruthy()
  mock.error = new Error('Offline')
  rerender(<EnvironmentInfoPanel side="right" />)
  expect(screen.getByText('Could not load room climate: Offline')).toBeTruthy()
  mock.loading = true
  rerender(<EnvironmentInfoPanel side="right" />)
  expect(screen.queryByText('Room')).toBeNull()
})

it('buffers raw frames while closed, filters, pauses inspection and resumes on close', () => {
  const { container } = render(<RawFrameDrawer />)
  fireEvent.click(screen.getByRole('button', { name: 'Raw frames' }))
  expect(screen.getByText('Waiting for frames')).toBeTruthy()
  emit({ type: 'log', msg: 'first' })
  emit({ type: 'gesture', side: 'left' })
  fireEvent.click(screen.getByRole('button', { name: 'log' }))
  fireEvent.click(screen.getByRole('button', { name: /log\s*\d/ }))
  expect(screen.getByRole('button', { name: 'Paused' })).toBeTruthy()
  expect(document.querySelector('pre')?.textContent).toContain('first')
  emit({ type: 'log', msg: 'second' })
  expect(document.querySelector('pre')?.textContent).not.toContain('second')
  fireEvent.click(screen.getByRole('button', { name: /log\s*\d/ }))
  expect(document.querySelector('pre')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'All' }))
  fireEvent.click(screen.getByRole('button', { name: 'Paused' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  emit({ type: 'log', msg: 'third' })
  fireEvent.click(within(container).getByRole('button', { name: 'Raw frames' }))
  expect(screen.getByRole('button', { name: 'Live' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: /log\s*\d/ })).toHaveLength(3)
})

it('shows firmware logs and gestures, filters raw frames, pauses and clears each view', () => {
  render(<FirmwareLogConsole />)
  expect(screen.getByText('Waiting for firmware logs')).toBeTruthy()
  emit({ type: 'log', ts: 1700000000, level: 'custom', msg: 'hello' })
  emit({ type: 'gesture', ts: Date.now(), side: 'left', tapType: 'double' })
  expect(screen.getByText('hello')).toBeTruthy()
  expect(screen.getByText('[TAP] left double')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  emit({ type: 'log', ts: 0, level: 'INFO', msg: 'paused' })
  expect(screen.queryByText('paused')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Frames' }))
  fireEvent.click(screen.getByRole('button', { name: 'gesture' }))
  const row = screen.getByRole('button', { name: /gesture.*s$/ })
  fireEvent.click(row)
  expect(document.querySelector('pre')?.textContent).toContain('double')
  fireEvent.click(row)
  fireEvent.click(screen.getByRole('button', { name: 'All' }))
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  expect(screen.getByText('Waiting for frames')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Logs' }))
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  expect(screen.getByText('Waiting for firmware logs')).toBeTruthy()
})

it('holds presence and freezer slots with skeletons until the first query resolves', () => {
  mock.loading = true
  const { rerender } = render(
    <>
      <PresenceCard />
      <FreezerHealthCard />
    </>,
  )
  expect(screen.getByTestId('presence-loading')).toBeTruthy()
  expect(screen.queryByTestId('presence-left')).toBeNull()
  expect(screen.getByTestId('freezer-loading')).toBeTruthy()
  expect(screen.queryByText('No data')).toBeNull()

  // Live frames beat the stored fallback: no skeleton while the DB query is still pending.
  mock.frames.frzHealth = { left: { tecCurrent: 1, pumpRpm: 100, flowrate: null }, right: { tecCurrent: 1, pumpRpm: 100, flowrate: null }, fan: { rpm: 200 } }
  rerender(
    <>
      <PresenceCard />
      <FreezerHealthCard />
    </>,
  )
  expect(screen.queryByTestId('freezer-loading')).toBeNull()

  mock.loading = false
  rerender(
    <>
      <PresenceCard />
      <FreezerHealthCard />
    </>,
  )
  expect(screen.queryByTestId('presence-loading')).toBeNull()
  expect(screen.getByTestId('presence-left')).toBeTruthy()
})
