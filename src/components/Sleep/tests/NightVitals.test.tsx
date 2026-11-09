import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NightVitals } from '../NightVitals'
import { Hypnogram } from '@/src/components/ds'

const mock = vi.hoisted(() => ({ query: vi.fn(), watch: vi.fn(() => ({ data: [] as unknown[] })), chart: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometrics: {
  getVitals: { useQuery: mock.query }, getReferenceVitals: { useQuery: mock.query },
  getReferenceSamples: { useQuery: mock.query }, getMovementBuckets: { useQuery: mock.query },
  getWatchMotionSeries: { useQuery: mock.watch },
} } }))
vi.mock('@/src/components/biometrics/VitalsExplorer', () => ({ VitalsExplorer: (props: unknown) => {
  mock.chart(props)
  return <div>Shared Biometrics chart</div>
} }))
afterEach(cleanup)
it('uses the same chart and scopes all three Watch metrics to the selected side and night', () => {
  mock.query.mockImplementation(input => ({ data: input.metric
    ? [{ timestamp: new Date(2000), value: input.metric === 'hrv_sdnn' ? 35 : 14 }]
    : input.limit === 100000
      ? [{ timestamp: new Date(1000), heartRate: 60, hrv: 40, breathingRate: 15 }]
      : input.bucketSeconds ? [] : [{ timestamp: new Date(2000), heartRate: 62 }] }))
  render(<NightVitals side="right" start={0} end={10000} />)
  expect(screen.getByText('Shared Biometrics chart')).toBeTruthy()
  expect(mock.query).toHaveBeenCalledWith(expect.objectContaining({ side: 'right', metric: 'breathing_rate', startDate: new Date(0), endDate: new Date(10000) }))
  expect(mock.chart).toHaveBeenCalledWith(expect.objectContaining({ reference: [{ t: 2000, hr: 62 }], referenceHrv: [{ t: 2000, value: 35 }], referenceBr: [{ t: 2000, value: 14 }] }))
})
it('passes blood oxygen to the chart and names it only inside a session', () => {
  mock.chart.mockClear()
  mock.query.mockImplementation(input => ({ data: input.metric === 'blood_oxygen'
    ? [{ timestamp: new Date(1000), value: 96 }, { timestamp: new Date(9000), value: 94 }]
    : input.limit === 100000 ? [{ timestamp: new Date(1000), heartRate: 60, hrv: 40, breathingRate: 15 }] : [] }))
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(mock.chart).toHaveBeenCalledWith(expect.objectContaining({ referenceOxygen: [{ t: 1000, value: 96 }, { t: 9000, value: 94 }] }))
  expect(screen.getByText('blood oxygen')).toBeTruthy()
  cleanup()
  mock.query.mockImplementation(input => ({ data: input.metric === 'blood_oxygen'
    ? [{ timestamp: new Date(9000), value: 94 }]
    : input.limit === 100000 ? [{ timestamp: new Date(1000), heartRate: 60, hrv: 40, breathingRate: 15 }] : [] }))
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(screen.queryByText('blood oxygen')).toBeNull()
})
it('reports a failed blood-oxygen request without hiding the chart', () => {
  mock.query.mockImplementation(input => input.metric === 'blood_oxygen'
    ? { error: new Error('offline') }
    : { data: input.limit === 100000 ? [{ timestamp: new Date(1000), heartRate: 60, hrv: 40, breathingRate: 15 }] : [] })
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(screen.getByText('Some Apple Watch readings could not be loaded.')).toBeTruthy()
  expect(screen.getByText('Shared Biometrics chart')).toBeTruthy()
})
it('waits for blood oxygen before drawing the night', () => {
  mock.chart.mockClear()
  mock.query.mockImplementation(input => input.metric === 'blood_oxygen' ? { isLoading: true } : { data: [] })
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(mock.chart).not.toHaveBeenCalled()
  expect(screen.queryByText('No recorded vitals for this night.')).toBeNull()
})
it('passes the night’s Watch movement to the chart and legend, and draws nothing extra without it', () => {
  mock.query.mockImplementation(input => ({ data: input.limit === 100000
    ? [{ timestamp: new Date(60_000), heartRate: 60, hrv: 40, breathingRate: 15 }, { timestamp: new Date(120_000), heartRate: 61, hrv: 40, breathingRate: 15 }]
    : [] }))
  render(<NightVitals side="left" start={0} end={600_000} />)
  expect(mock.watch).toHaveBeenCalledWith({ side: 'left', startDate: new Date(0), endDate: new Date(600_000) }, expect.objectContaining({ enabled: true }))
  expect(mock.chart).toHaveBeenLastCalledWith(expect.objectContaining({ watchMovement: [] }))
  expect(screen.queryByTestId('legend-watch-movement')).toBeNull()
  cleanup()
  mock.watch.mockReturnValue({ data: [{ timestamp: new Date(60_000), movingSamples: 7 }] })
  render(<NightVitals side="left" start={0} end={600_000} />)
  expect(mock.chart).toHaveBeenLastCalledWith(expect.objectContaining({ watchMovement: [{ t: 60_000, moving: 7 }] }))
  expect(screen.getByTestId('legend-watch-movement')).toBeTruthy()
})
it('reports a failed recorded-vitals request', () => {
  mock.query.mockReturnValue({ error: new Error('offline') })
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(screen.getByText('Could not load this night’s recorded vitals.')).toBeTruthy()
})
it('connects adjacent stage transitions but never bridges missing Watch intervals', () => {
  render(
    <Hypnogram
      blocks={[]}
      reference={[
        { stage: 'light', startPct: 0, widthPct: 10 },
        { stage: 'deep', startPct: 10, widthPct: 10 },
        { stage: 'rem', startPct: 40, widthPct: 10 },
      ]}
    />
  )
  const paths = screen.getByRole('img').querySelectorAll('path')
  expect(paths[1].getAttribute('d')).toBe('M 10 65 V 91 H 20')
  expect(paths[2].getAttribute('d')).toBe('M 40 39 V 39 H 50')
})

it.each(['hr', 'hrv_sdnn', 'hrv_rmssd', 'breathing_rate', 'blood_oxygen'])('draws reference-only %s sessions with null pod metrics', (metric) => {
  mock.chart.mockClear()
  mock.query.mockImplementation(input => ({ data: input.metric === metric
    ? [{ timestamp: new Date(2000), value: 35 }]
    : metric === 'hr' && input.limit === 20000 && !input.metric
      ? [{ timestamp: new Date(2000), heartRate: 62 }]
      : [] }))
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(screen.queryByText('No recorded vitals for this night.')).toBeNull()
  expect(mock.chart.mock.calls[0][0].sessions[0].points).toEqual([{ t: 2000, hr: null, hrv: null, br: null }])
})

it('names RMSSD and explains comparability when the Watch reported it', () => {
  mock.query.mockImplementation(input => ({ data: input.metric === 'hrv_rmssd' ? [{ timestamp: new Date(2000), value: 32 }] : [] }))
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(screen.getByText('HRV · RMSSD')).toBeTruthy()
  expect(screen.getByText(/Watch SDNN, Watch RMSSD and sleepypod/)).toBeTruthy()
})

it.each(['hrv_sdnn', 'hrv_rmssd', 'breathing_rate'])('reports a failed %s request', (metric) => {
  mock.query.mockImplementation(input => (input.metric === metric ? { error: new Error('offline') } : { data: [] }))
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(screen.getByText('Some Apple Watch readings could not be loaded.')).toBeTruthy()
})

it.each(['hrv_sdnn', 'hrv_rmssd', 'breathing_rate'])('waits for %s before drawing the night', (metric) => {
  mock.query.mockImplementation(input => (input.metric === metric ? { isLoading: true } : { data: [] }))
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(screen.queryByText('No recorded vitals for this night.')).toBeNull()
})

it('omits the optional RMSSD legend when no Watch data exists', () => {
  mock.query.mockReturnValue({ data: [] })
  render(<NightVitals side="left" start={0} end={10000} />)
  expect(screen.queryByText('HRV · RMSSD')).toBeNull()
})
