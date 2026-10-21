import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NightHeartRate, NightHrv } from '../NightHrv'
import { Hypnogram } from '@/src/components/ds'

const query = vi.hoisted(() => vi.fn())
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometrics: { getReferenceSamples: { useQuery: query }, getReferenceVitals: { useQuery: query } } } }))
vi.mock('@/src/hooks/useTimeFormatter', () => ({ useTimeFormatter: () => ({ formatClock: (t: number) => String(t) }) }))
afterEach(cleanup)
it('places intermittent Watch samples by timestamp and requests the selected side', () => {
  query.mockReturnValue({ data: [{ timestamp: new Date(2500), value: 40 }, { timestamp: new Date(7500), value: 50 }] })
  render(<NightHrv side="right" start={0} end={10000} epochs={[]} />)
  const dots = screen.getByRole('img').querySelectorAll('circle')
  expect([...dots].map(p => p.getAttribute('cx'))).toEqual(['250', '750'])
  expect(screen.getByText('Apple Watch SDNN · 2 samples')).toBeTruthy()
  expect(query).toHaveBeenCalledWith(expect.objectContaining({ side: 'right', metric: 'hrv_sdnn' }))
})
it('keeps the pod chart visible when Watch loading fails', () => {
  query.mockReturnValue({ error: new Error('offline') })
  render(<NightHrv side="left" start={0} end={10000} epochs={[{ start: 100, hrv: 30 }]} />)
  expect(screen.getByRole('img')).toBeTruthy()
  expect(screen.getByText('Could not load Apple Watch HRV.')).toBeTruthy()
  expect(screen.queryByText(/Apple Watch SDNN ·/)).toBeNull()
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

it('overlays Watch heart rate in BPM without stretching circles or bridging large gaps', () => {
  query.mockReturnValue({ data: [{ timestamp: new Date(1000), heartRate: 60 }, { timestamp: new Date(2000), heartRate: 62 }, { timestamp: new Date(2000000), heartRate: 70 }] })
  render(<NightHeartRate side="left" start={0} end={3000000} epochs={[]} />)
  const chart = screen.getByRole('img', { name: 'Night heart rate comparison' })
  expect(chart.getAttribute('preserveAspectRatio')).toBeNull()
  expect(chart.querySelectorAll('circle')).toHaveLength(3)
  expect(chart.querySelectorAll('line')).toHaveLength(1)
  expect(screen.getByText('Apple Watch heart rate · 3 samples')).toBeTruthy()
})
