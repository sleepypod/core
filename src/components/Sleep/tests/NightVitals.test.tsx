import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NightVitals } from '../NightVitals'
import { Hypnogram } from '@/src/components/ds'

const mock = vi.hoisted(() => ({ query: vi.fn(), chart: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometrics: {
  getVitals: { useQuery: mock.query }, getReferenceVitals: { useQuery: mock.query },
  getReferenceSamples: { useQuery: mock.query }, getMovementBuckets: { useQuery: mock.query },
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

it.each(['hr', 'hrv_sdnn', 'breathing_rate'])('draws reference-only %s sessions with null pod metrics', (metric) => {
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
