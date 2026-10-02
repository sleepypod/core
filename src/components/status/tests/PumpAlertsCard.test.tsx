/**
 * Tests for PumpAlertsCard — active-alert rows with per-row dismiss, the
 * dismiss-all drain for backlogs, and the render-nothing empty state.
 */

import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const dismissMutate = vi.fn()
  const dismissMutateAsync = vi.fn(async () => ({ success: true }))
  const invalidate = vi.fn()
  const state = { alerts: [] as unknown[] }
  return {
    dismissMutate,
    dismissMutateAsync,
    invalidate,
    state,
    trpc: {
      useUtils: () => ({ pumpAlerts: { list: { invalidate } } }),
      pumpAlerts: {
        list: { useQuery: () => ({ data: state.alerts }) },
        dismissAlert: {
          useMutation: () => ({
            mutate: dismissMutate,
            mutateAsync: dismissMutateAsync,
            isPending: false,
          }),
        },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { PumpAlertsCard } from '../PumpAlertsCard'

const makeAlert = (id: number, side: 'left' | 'right' | null, ageMs: number, overrides: Record<string, unknown> = {}) => ({
  id,
  timestamp: new Date(Date.now() - ageMs),
  type: side === 'right' ? 'stall_right' : 'stall_left',
  side,
  rpm: 120,
  flowrateCd: null,
  durationSeconds: null,
  action: 'power_off',
  restoreTargetTemperature: null,
  restoreDurationSeconds: null,
  acknowledgedAt: null,
  dismissedAt: null,
  ...overrides,
})

beforeEach(() => {
  trpcMock.dismissMutate.mockClear()
  trpcMock.dismissMutateAsync.mockClear()
  trpcMock.invalidate.mockClear()
  trpcMock.state.alerts = []
})

describe('PumpAlertsCard', () => {
  it('renders nothing when there are no active alerts', () => {
    const { container } = render(<PumpAlertsCard />)
    expect(container.firstChild).toBeNull()
  })

  it('renders side, rpm, and relative age for each active row', () => {
    trpcMock.state.alerts = [
      makeAlert(5, 'left', 2 * 60 * 60 * 1000),
      makeAlert(6, 'right', 3 * 24 * 60 * 60 * 1000),
    ]
    const { getByText } = render(<PumpAlertsCard />)
    expect(getByText('Left — 120 rpm — 2h ago')).toBeTruthy()
    expect(getByText('Right — 120 rpm — 3d ago')).toBeTruthy()
  })

  it('dismisses a single row by id', () => {
    trpcMock.state.alerts = [makeAlert(5, 'left', 60_000)]
    const { getByLabelText } = render(<PumpAlertsCard />)
    fireEvent.click(getByLabelText('Dismiss pump alert 5'))
    expect(trpcMock.dismissMutate).toHaveBeenCalledTimes(1)
    expect(trpcMock.dismissMutate).toHaveBeenCalledWith({ id: 5 })
  })

  it('offers dismiss-all only for a backlog and drains every row', async () => {
    trpcMock.state.alerts = [
      makeAlert(5, 'left', 60_000),
      makeAlert(6, 'left', 120_000),
      makeAlert(7, 'right', 180_000),
    ]
    const { getByText } = render(<PumpAlertsCard />)
    fireEvent.click(getByText('Dismiss all'))
    await waitFor(() => expect(trpcMock.dismissMutateAsync).toHaveBeenCalledTimes(3))
    expect(trpcMock.dismissMutateAsync).toHaveBeenCalledWith({ id: 5 })
    expect(trpcMock.dismissMutateAsync).toHaveBeenCalledWith({ id: 6 })
    expect(trpcMock.dismissMutateAsync).toHaveBeenCalledWith({ id: 7 })
  })

  it('keeps draining when a row was already dismissed elsewhere', async () => {
    trpcMock.state.alerts = [
      makeAlert(5, 'left', 60_000),
      makeAlert(6, 'left', 120_000),
    ]
    trpcMock.dismissMutateAsync.mockRejectedValueOnce(new Error('NOT_FOUND'))
    const { getByText } = render(<PumpAlertsCard />)
    fireEvent.click(getByText('Dismiss all'))
    await waitFor(() => expect(trpcMock.dismissMutateAsync).toHaveBeenCalledTimes(2))
    expect(trpcMock.dismissMutateAsync).toHaveBeenCalledWith({ id: 6 })
  })

  it('hides dismiss-all when only one alert is active', () => {
    trpcMock.state.alerts = [makeAlert(5, 'left', 60_000)]
    const { queryByText } = render(<PumpAlertsCard />)
    expect(queryByText('Dismiss all')).toBeNull()
  })

  it('labels a sideless alert Both and falls back to the alert type without rpm', () => {
    trpcMock.state.alerts = [makeAlert(9, null, 60_000, { type: 'asymmetry', rpm: null })]
    const { getByText } = render(<PumpAlertsCard />)
    expect(getByText('Both — asymmetry — 1m ago')).toBeTruthy()
  })

  it('formats ages across the minute, hour, and day boundaries', () => {
    trpcMock.state.alerts = [
      makeAlert(1, 'left', 59 * 60_000),
      makeAlert(2, 'left', 60 * 60_000),
      makeAlert(3, 'left', 47 * 3_600_000),
      makeAlert(4, 'left', 48 * 3_600_000),
      // Future timestamp (clock skew) clamps to zero, never negative.
      makeAlert(5, 'left', -5 * 60_000),
    ]
    const { getByText } = render(<PumpAlertsCard />)
    expect(getByText(/59m ago/)).toBeTruthy()
    expect(getByText(/1h ago/)).toBeTruthy()
    expect(getByText(/47h ago/)).toBeTruthy()
    expect(getByText(/2d ago/)).toBeTruthy()
    expect(getByText(/0m ago/)).toBeTruthy()
  })
})
