import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SensorsScreen } from '../SensorsScreen'

const m = vi.hoisted(() => ({ loading: false, error: false, data: undefined as unknown, summary: undefined as unknown, query: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { environment: {
  getBedTemp: { useQuery: (input: unknown) => {
    m.query(input)
    return { data: m.data, isLoading: m.loading, isError: m.error }
  } },
  getSummary: { useQuery: () => ({ data: m.summary }) },
} } }))
vi.mock('../PresenceCard', () => ({ PresenceCard: () => null }))
vi.mock('../BedTempMatrix', () => ({ BedTempMatrix: () => null }))
vi.mock('../FreezerHealthCard', () => ({ FreezerHealthCard: () => null }))
vi.mock('../FlowrateChart', () => ({ FlowrateChart: () => null }))
vi.mock('../PiezoWaveform', () => ({ PiezoWaveform: ({ enabled }: { enabled: boolean }) => <div>{`Stream ${enabled}`}</div> }))
vi.mock('@/src/components/Environment/BedTempChart', () => ({ BedTempChart: ({ data }: { data: unknown[] }) => <div>{`Temperatures ${data.length}`}</div> }))
vi.mock('@/src/components/Environment/HumidityChart', () => ({ HumidityChart: ({ data }: { data: unknown[] }) => <div>{`Humidity ${data.length}`}</div> }))
beforeEach(() => {
  vi.clearAllMocks()
  m.loading = false
  m.error = false
  m.data = undefined
  m.summary = undefined
})

it('selects bounded trend ranges and passes stream state to the waveform', () => {
  const { rerender } = render(<SensorsScreen />)
  expect(m.query).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 360, unit: 'F' }))
  expect(screen.getByText('Stream true')).toBeTruthy()
  expect(screen.getByText('Temperatures 0')).toBeTruthy()
  for (const [range, limit] of [['1h', 60], ['24h', 1440]] as const) {
    fireEvent.click(screen.getByRole('tab', { name: range }))
    expect(m.query).toHaveBeenLastCalledWith(expect.objectContaining({ limit }))
  }
  m.data = [{ timestamp: 1 }]
  rerender(<SensorsScreen streamEnabled={false} />)
  expect(screen.getByText('Temperatures 1')).toBeTruthy()
  expect(screen.getByText('Humidity 1')).toBeTruthy()
  expect(screen.getByText('Stream false')).toBeTruthy()
})

it('shows loading, failed queries, rounded summaries and missing summary values', () => {
  m.loading = true
  const { rerender } = render(<SensorsScreen />)
  expect(screen.queryByText('Temperatures 0')).toBeNull()
  m.loading = false
  m.error = true
  rerender(<SensorsScreen />)
  expect(screen.getByText('Failed to load temperature data')).toBeTruthy()
  m.error = false
  m.summary = { bedTemp: { avgLeftCenterTemp: 80.2, avgRightCenterTemp: 82.6, avgAmbientTemp: 70.8, avgHumidity: 45.6 } }
  rerender(<SensorsScreen />)
  for (const value of ['80°', '83°', '71°', '46%']) expect(screen.getByText(value)).toBeTruthy()
  m.summary = { bedTemp: {} }
  rerender(<SensorsScreen />)
  expect(screen.getAllByText('--')).toHaveLength(4)
})
