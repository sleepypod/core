/**
 * useTempNotices — the Temperature screen's device notices. Ported from the old
 * AlarmBanner / PumpStallNotification tests (Stop / Snooze / Cancel targeting,
 * alert-id correlation, dual-pending lockout) plus side blocking and the
 * prime-complete toast: exactly one toast and one dismiss per completion, and a
 * silent dismiss for a stale one.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DsModule from '@/src/components/ds'
import { NoticeStack } from '@/src/components/ds'

const m = vi.hoisted(() => ({
  clearMutate: vi.fn(),
  snoozeMutate: vi.fn(),
  ackMutate: vi.fn(),
  stallDismissMutate: vi.fn(),
  primeDismissMutate: vi.fn(),
  show: vi.fn(),
  refetch: vi.fn(),
  pending: { acknowledge: false, dismiss: false },
  activeSides: ['left', 'right'] as string[],
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    device: {
      clearAlarm: { useMutation: () => ({ mutate: m.clearMutate, isPending: false }) },
      snoozeAlarm: { useMutation: () => ({ mutate: m.snoozeMutate, isPending: false }) },
      dismissPrimeNotification: { useMutation: () => ({ mutate: m.primeDismissMutate, isPending: false }) },
    },
    pumpAlerts: {
      acknowledgeAndRestore: { useMutation: () => ({ mutate: m.ackMutate, isPending: m.pending.acknowledge }) },
      dismissNotification: { useMutation: () => ({ mutate: m.stallDismissMutate, isPending: m.pending.dismiss }) },
    },
  },
}))
vi.mock('@/src/providers/SideProvider', () => ({ useSide: () => ({ activeSides: m.activeSides }) }))
vi.mock('@/src/components/ds', async importOriginal => ({
  ...await importOriginal<typeof DsModule>(),
  useToast: () => ({ show: m.show }),
}))

import { useTempNotices } from '../useTempNotices'

type Status = Parameters<typeof useTempNotices>[0]

function Harness({ status, enabled }: { status: unknown, enabled?: boolean }) {
  const { notices, blocked } = useTempNotices(status as Status, m.refetch, { enabled })
  return (
    <>
      <NoticeStack notices={notices} />
      <span data-testid="blocked">{JSON.stringify(blocked)}</span>
    </>
  )
}

const NOW_S = Math.floor(Date.now() / 1000)
const base = { leftSide: { isAlarmVibrating: false }, rightSide: { isAlarmVibrating: false }, isPriming: false }
const futureSnooze = { active: true, snoozeUntil: NOW_S + 240 }
const blocked = () => JSON.parse(screen.getByTestId('blocked').textContent ?? '{}')

beforeEach(() => {
  vi.clearAllMocks()
  m.pending.acknowledge = false
  m.pending.dismiss = false
  m.activeSides = ['left', 'right']
})
afterEach(cleanup)

describe('alarm', () => {
  it('renders nothing when no alarm is active and nothing is snoozed', () => {
    render(<Harness status={base} />)
    expect(screen.queryByTestId('notice-stack')).toBeNull()
  })

  it('Stop clears the actively vibrating sides', () => {
    render(<Harness status={{ ...base, leftSide: { isAlarmVibrating: true } }} />)
    expect(screen.getByText('Alarm active')).toBeTruthy()
    expect(screen.getByText('Left side vibrating')).toBeTruthy()
    fireEvent.click(screen.getByText('Stop'))
    expect(m.clearMutate).toHaveBeenCalledExactlyOnceWith({ side: 'left' }, expect.anything())
  })

  it('Snooze targets the vibrating side', () => {
    render(<Harness status={{ ...base, rightSide: { isAlarmVibrating: true } }} />)
    fireEvent.click(screen.getByText('Snooze 5m'))
    expect(m.snoozeMutate).toHaveBeenCalledExactlyOnceWith({ side: 'right', duration: 300 }, expect.anything())
  })

  it('shows a snoozed alarm as progress with the minutes left in mono', () => {
    render(<Harness status={{ ...base, snooze: { left: futureSnooze, right: null } }} />)
    expect(screen.getByRole('status').textContent).toContain('Alarm snoozed')
    expect(screen.getByText('4M').className).toContain('font-mono')
  })

  it('Cancel during snooze clears the snoozed side (regression: was a no-op)', () => {
    render(<Harness status={{ ...base, snooze: { left: futureSnooze, right: null } }} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(m.clearMutate).toHaveBeenCalledExactlyOnceWith({ side: 'left' }, expect.anything())
  })

  it('Cancel clears every snoozed side when both are snoozed', () => {
    render(<Harness status={{ ...base, snooze: { left: futureSnooze, right: futureSnooze } }} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(m.clearMutate).toHaveBeenCalledTimes(2)
    expect(m.clearMutate).toHaveBeenCalledWith({ side: 'left' }, expect.anything())
    expect(m.clearMutate).toHaveBeenCalledWith({ side: 'right' }, expect.anything())
  })

  it('Cancel targets the snoozed side even when activeSides shows only the other side', () => {
    m.activeSides = ['left']
    render(<Harness status={{ ...base, snooze: { left: null, right: futureSnooze } }} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(m.clearMutate).toHaveBeenCalledExactlyOnceWith({ side: 'right' }, expect.anything())
  })

  it('does not block either side', () => {
    render(<Harness status={{ ...base, leftSide: { isAlarmVibrating: true } }} />)
    expect(blocked()).toEqual({ left: false, right: false })
  })
})

describe('pump stall', () => {
  const stall = (side: 'left' | 'right', alertId = 38) => ({
    ...base,
    pumpStallNotifications: { [side]: { rpm: 40, trippedAt: 1_720_000_000, alertId } },
  })

  it('passes the side and alert id to acknowledgeAndRestore on Re-enable', () => {
    render(<Harness status={stall('left')} />)
    fireEvent.click(screen.getByText('Re-enable'))
    expect(m.ackMutate).toHaveBeenCalledExactlyOnceWith({ side: 'left', alertId: 38 }, expect.anything())
  })

  it('passes the side and alert id to dismissNotification on Dismiss', () => {
    render(<Harness status={stall('right')} />)
    fireEvent.click(screen.getByLabelText('Dismiss pump stall notification'))
    expect(m.stallDismissMutate).toHaveBeenCalledExactlyOnceWith({ side: 'right', alertId: 38 }, expect.anything())
  })

  it('omits the alert id when the trip-time insert failed (alertId 0)', () => {
    render(<Harness status={stall('left', 0)} />)
    fireEvent.click(screen.getByText('Re-enable'))
    fireEvent.click(screen.getByLabelText('Dismiss pump stall notification'))
    expect(m.ackMutate).toHaveBeenCalledWith({ side: 'left', alertId: undefined }, expect.anything())
    expect(m.stallDismissMutate).toHaveBeenCalledWith({ side: 'left', alertId: undefined }, expect.anything())
  })

  it.each(['acknowledge', 'dismiss'] as const)('disables both buttons while the %s mutation is pending', (which) => {
    m.pending[which] = true
    render(<Harness status={stall('left')} />)
    expect((screen.getByText('Re-enable') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Dismiss pump stall notification') as HTMLButtonElement).disabled).toBe(true)
  })

  it('exposes the banner as an alert, with plain-sentence copy, and blocks only its own side', () => {
    render(<Harness status={stall('left')} />)
    expect(screen.getByRole('alert').textContent).toContain('Left side powered off. Pump stall detected.')
    expect(screen.getByRole('alert').textContent).not.toContain('—')
    expect(blocked()).toEqual({ left: true, right: false })
  })
})

describe('priming', () => {
  it('shows a cool progress banner without an invented estimate and blocks both sides', () => {
    render(<Harness status={{ ...base, isPriming: true }} />)
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('Priming')
    expect(banner.textContent).toContain('Temperature controls resume when it finishes')
    expect(screen.queryByTestId('notice-progress')).toBeNull()
    expect(banner.innerHTML).not.toContain('animate-pulse')
    expect(blocked()).toEqual({ left: true, right: true })
  })
})

describe('prime complete', () => {
  const flagged = (timestamp: unknown, extra = {}) => ({ ...base, primeCompletedNotification: { timestamp }, ...extra })

  it('toasts exactly once and dismisses exactly once, even when polling returns the flag again', () => {
    const { rerender } = render(<Harness status={flagged(NOW_S - 60)} />)
    rerender(<Harness status={flagged(NOW_S - 60)} />)
    rerender(<Harness status={{ ...flagged(NOW_S - 60) }} />)
    expect(m.show).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'prime-complete', kind: 'success', tone: 'ok', title: 'Priming complete. Your pod is ready.' }))
    expect(m.primeDismissMutate).toHaveBeenCalledTimes(1)
    // A second mount (the stage after the cards) does not toast the same completion.
    cleanup()
    render(<Harness status={flagged(NOW_S - 60)} />)
    expect(m.show).toHaveBeenCalledTimes(1)
    expect(m.primeDismissMutate).toHaveBeenCalledTimes(1)
  })

  it('reads the WebSocket form (seconds wrapped in a Date) as the same moment', () => {
    render(<Harness status={flagged(new Date(NOW_S - 120))} />)
    expect(m.show).toHaveBeenCalledTimes(1)
  })

  it('dismisses a completion older than an hour without a toast', () => {
    render(<Harness status={flagged(NOW_S - 2 * 3600)} />)
    expect(m.show).not.toHaveBeenCalled()
    expect(m.primeDismissMutate).toHaveBeenCalledTimes(1)
  })

  it('waits while still priming, and while the screen is hidden', () => {
    const { rerender } = render(<Harness status={flagged(NOW_S - 30, { isPriming: true })} />)
    rerender(<Harness status={flagged(NOW_S - 30)} enabled={false} />)
    expect(m.show).not.toHaveBeenCalled()
    expect(m.primeDismissMutate).not.toHaveBeenCalled()
    rerender(<Harness status={flagged(NOW_S - 30)} />)
    expect(m.show).toHaveBeenCalledTimes(1)
    expect(m.primeDismissMutate).toHaveBeenCalledTimes(1)
  })
})
