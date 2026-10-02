/**
 * Tests for PumpStallNotification — alert-id correlation on both mutations,
 * dual-pending button lockout (Re-enable and Dismiss race for the same
 * guard state), and the banner's accessibility contract.
 */

import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const ackMutate = vi.fn()
  const dismissMutate = vi.fn()
  const pending = { acknowledge: false, dismiss: false }
  return {
    ackMutate,
    dismissMutate,
    pending,
    trpc: {
      pumpAlerts: {
        acknowledgeAndRestore: { useMutation: () => ({ mutate: ackMutate, isPending: pending.acknowledge }) },
        dismissNotification: { useMutation: () => ({ mutate: dismissMutate, isPending: pending.dismiss }) },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { PumpStallNotification } from '../PumpStallNotification'

beforeEach(() => {
  trpcMock.ackMutate.mockClear()
  trpcMock.dismissMutate.mockClear()
  trpcMock.pending.acknowledge = false
  trpcMock.pending.dismiss = false
})

describe('PumpStallNotification', () => {
  it('passes the side and alert id to acknowledgeAndRestore on Re-enable', () => {
    const { getByText } = render(
      <PumpStallNotification side="left" rpm={40} trippedAt={1_720_000_000} alertId={38} />,
    )
    fireEvent.click(getByText('Re-enable'))
    expect(trpcMock.ackMutate).toHaveBeenCalledTimes(1)
    expect(trpcMock.ackMutate).toHaveBeenCalledWith({ side: 'left', alertId: 38 }, expect.anything())
  })

  it('passes the side and alert id to dismissNotification on Dismiss', () => {
    const { getByLabelText } = render(
      <PumpStallNotification side="right" rpm={40} trippedAt={1_720_000_000} alertId={38} />,
    )
    fireEvent.click(getByLabelText('Dismiss pump stall notification'))
    expect(trpcMock.dismissMutate).toHaveBeenCalledTimes(1)
    expect(trpcMock.dismissMutate).toHaveBeenCalledWith({ side: 'right', alertId: 38 }, expect.anything())
  })

  it('omits the alert id when the trip-time insert failed (alertId 0)', () => {
    const { getByText, getByLabelText } = render(
      <PumpStallNotification side="left" rpm={40} trippedAt={1_720_000_000} alertId={0} />,
    )
    fireEvent.click(getByText('Re-enable'))
    fireEvent.click(getByLabelText('Dismiss pump stall notification'))
    expect(trpcMock.ackMutate).toHaveBeenCalledWith({ side: 'left', alertId: undefined }, expect.anything())
    expect(trpcMock.dismissMutate).toHaveBeenCalledWith({ side: 'left', alertId: undefined }, expect.anything())
  })

  it('disables both buttons while the acknowledge mutation is pending', () => {
    trpcMock.pending.acknowledge = true
    const { getByText, getByLabelText } = render(
      <PumpStallNotification side="left" rpm={40} trippedAt={1_720_000_000} alertId={38} />,
    )
    expect((getByText('Re-enable') as HTMLButtonElement).disabled).toBe(true)
    expect((getByLabelText('Dismiss pump stall notification') as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables both buttons while the dismiss mutation is pending', () => {
    trpcMock.pending.dismiss = true
    const { getByText, getByLabelText } = render(
      <PumpStallNotification side="left" rpm={40} trippedAt={1_720_000_000} alertId={38} />,
    )
    expect((getByText('Re-enable') as HTMLButtonElement).disabled).toBe(true)
    expect((getByLabelText('Dismiss pump stall notification') as HTMLButtonElement).disabled).toBe(true)
  })

  it('exposes the banner as an alert for assistive tech', () => {
    const { getByRole } = render(
      <PumpStallNotification side="left" rpm={40} trippedAt={1_720_000_000} alertId={38} />,
    )
    expect(getByRole('alert').textContent).toContain('side powered off — pump stall detected')
  })
})
