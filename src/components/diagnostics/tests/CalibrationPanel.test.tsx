import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CalibrationPanel } from '../CalibrationPanel'
import type { SensorFrame } from '@/src/hooks/useSensorStream'

const mock = vi.hoisted(() => ({
  frame: (_f: SensorFrame) => {
    void _f
  }, data: undefined as unknown, loading: false,
  single: vi.fn(), full: vi.fn(), invalidate: vi.fn(), side: vi.fn(),
  singleSuccess: () => {}, singleError: () => {}, fullSuccess: () => {}, error: null as null | Error,
}))
vi.mock('@/src/hooks/useSensorStream', () => ({ useOnSensorFrame: (cb: typeof mock.frame) => {
  mock.frame = cb
} }))
vi.mock('@/src/hooks/useSide', () => ({ useSide: () => ({ side: 'left', setSide: mock.side }) }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Alex', rightName: 'Right' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ convert: (n: number) => n, formatTemp: (n: number) => `${n}°C`, suffix: '°C' }) }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ calibration: { getStatus: { invalidate: mock.invalidate } } }),
  calibration: {
    getStatus: { useQuery: () => ({ data: mock.data, isLoading: mock.loading }) },
    triggerCalibration: { useMutation: (opts: { onSuccess: () => void, onError: () => void }) => {
      mock.singleSuccess = opts.onSuccess
      mock.singleError = opts.onError
      return { mutate: mock.single, error: mock.error }
    } },
    triggerFullCalibration: { useMutation: (opts: { onSuccess: () => void }) => {
      mock.fullSuccess = opts.onSuccess
      return { mutate: mock.full }
    } },
  },
} }))
const capParams = { format: 'capSense2', threshold: 100, channels: { A: { mean: 1, std: 0.1 }, B: { mean: 1, std: 0.1 }, C: { mean: 1, std: 0.1 } } }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-29T00:00:00Z'))
  mock.data = undefined
  mock.loading = false
  mock.error = null
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())
const emit = (frame: object) => mock.frame(frame as SensorFrame)

it('calibrates a sensor or all sensors, resets pending state, and displays errors', () => {
  const { rerender, unmount } = render(<CalibrationPanel />)
  expect(screen.getByText('waiting for left piezo…')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Right' }))
  expect(mock.side).toHaveBeenCalledWith('right')
  fireEvent.click(within(screen.getByTestId('cal-piezo')).getByRole('button', { name: 'Calibrate' }))
  expect(mock.single).toHaveBeenCalledWith({ side: 'left', sensorType: 'piezo' })
  expect(screen.getByRole('button', { name: 'Starting…' }).hasAttribute('disabled')).toBe(true)
  act(() => mock.singleSuccess())
  expect(mock.invalidate).toHaveBeenCalledWith({ side: 'left' })
  fireEvent.click(screen.getByRole('button', { name: 'Calibrate all' }))
  expect(mock.full).toHaveBeenCalledWith({})
  act(() => mock.fullSuccess())
  fireEvent.click(within(screen.getByTestId('cal-piezo')).getByRole('button'))
  act(() => mock.singleError())
  mock.error = new Error('Calibration unavailable')
  rerender(<CalibrationPanel />)
  expect(screen.getByText('Calibration unavailable')).toBeTruthy()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('plots live piezo, capacitance and temperature against calibration bands, then trims expired frames', () => {
  const profile = { status: 'completed', qualityScore: 0.95, samplesUsed: 1000, createdAt: new Date(Date.now() - 3600000), expiresAt: new Date(Date.now() + 3600000) }
  mock.data = { piezo: { ...profile, parameters: { baseline_mean_range: 10, presence_threshold: 20 } }, capacitance: { ...profile, parameters: capParams }, temperature: { ...profile, parameters: { ambient_mean: 2500, offsets: { left_outer_temp: 0, left_center_temp: 0, left_inner_temp: 0 } } } }
  const { container } = render(<CalibrationPanel />)
  act(() => {
    for (let i = 0; i < 2; i++) {
      emit({ type: 'piezo-dual', left1: [0, 30, -10, 20], right1: [] })
      emit({ type: 'capSense2', left: [2, 2, 2, 2, 2, 2, 1.16, 1.16], right: [1, 1, 1, 1, 1, 1, 1.16, 1.16] })
      emit({ type: 'bedTemp2', leftCenterTemp: 25, leftOuterTemp: 24, rightCenterTemp: 26 })
      vi.advanceTimersByTime(250)
    }
  })
  expect(screen.getByText('occupied · range 40 of 20')).toBeTruthy()
  expect(screen.getByText(/channels in baseline/)).toBeTruthy()
  expect(screen.getByLabelText('center zone °C').getAttribute('points')).not.toBe('')
  expect(container.querySelectorAll('polyline').length).toBeGreaterThanOrEqual(8)
  expect(screen.getAllByText('95%')).toHaveLength(3)

  // Hover at the right edge of each plot reads out the newest sample and how long ago it was.
  const boxes = ['cal-piezo', 'cal-capacitance', 'cal-temperature'].map(id => within(screen.getByTestId(id)).getByText(/^-(30s|10m)$/).parentElement?.previousElementSibling as HTMLElement)
  for (const box of boxes) vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 96, right: 400, bottom: 96, toJSON: () => ({}) })
  fireEvent.pointerMove(boxes[0], { clientX: 399, clientY: 10 })
  expect(screen.getByTestId('chart-hover').textContent).toMatch(/^-\d+s · range 40$/)
  fireEvent.pointerLeave(boxes[0])
  fireEvent.pointerMove(boxes[1], { clientX: 399, clientY: 10 })
  expect(screen.getByTestId('chart-hover').textContent).toMatch(/^-\d+s · [\d.]+ of 100$/)
  fireEvent.pointerLeave(boxes[1])
  fireEvent.pointerMove(boxes[2], { clientX: 399, clientY: 10 })
  expect(screen.getByTestId('chart-hover').textContent).toMatch(/^-\d+s · 25/)
  fireEvent.pointerLeave(boxes[2])
  expect(screen.queryByTestId('chart-hover')).toBeNull()
  act(() => {
    vi.advanceTimersByTime(610000)
    emit({ type: 'piezo-dual', left1: [0, 1], right1: [0, 1] })
    emit({ type: 'capSense', left: 1, right: 1 })
    emit({ type: 'bedTemp', leftCenterTemp: 24 })
    vi.advanceTimersByTime(250)
  })
  expect(screen.getByText('waiting for capacitance…')).toBeTruthy()
})

it('plots uncalibrated legacy signals and disables active calibration', () => {
  const { rerender } = render(<CalibrationPanel />)
  act(() => {
    for (let i = 0; i < 2; i++) {
      emit({ type: 'piezo-dual', left1: [0, 10], right1: [0, 1] })
      emit({ type: 'capSense', left: 100, right: 200 })
      emit({ type: 'bedTemp', leftCenterTemp: 24 })
      vi.advanceTimersByTime(250)
    }
  })
  expect(screen.getByText('raw reading · no capSense2 baseline')).toBeTruthy()
  const rawBox = within(screen.getByTestId('cal-capacitance')).getByText('-30s').parentElement?.previousElementSibling as HTMLElement
  vi.spyOn(rawBox, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 96, right: 400, bottom: 96, toJSON: () => ({}) })
  fireEvent.pointerMove(rawBox, { clientX: 399, clientY: 10 })
  expect(screen.getByTestId('chart-hover').textContent).toMatch(/^-\d+s · (100|200)$/)
  expect(screen.getByText('range 10 · not calibrated')).toBeTruthy()
  expect(screen.getByText('24°C · not calibrated')).toBeTruthy()
  mock.data = { piezo: { status: 'running' }, capacitance: { status: 'pending' }, temperature: { status: 'failed', errorMessage: 'No samples' } }
  rerender(<CalibrationPanel />)
  expect(screen.getByRole('button', { name: 'Running…' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Pending' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Calibrate all' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('No samples')).toBeTruthy()
})

it('shows one skeleton per sensor while calibration status is loading', () => {
  mock.loading = true
  const { rerender } = render(<CalibrationPanel />)
  expect(screen.getByTestId('cal-piezo-loading')).toBeTruthy()
  expect(screen.getByTestId('cal-capacitance-loading')).toBeTruthy()
  expect(screen.getByTestId('cal-temperature-loading')).toBeTruthy()
  expect(screen.queryByTestId('cal-piezo')).toBeNull()
  mock.loading = false
  rerender(<CalibrationPanel />)
  expect(screen.queryByTestId('cal-piezo-loading')).toBeNull()
  expect(screen.getByTestId('cal-piezo')).toBeTruthy()
})
