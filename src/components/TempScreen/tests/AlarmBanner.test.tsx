/**
 * Tests for AlarmBanner — active-alarm Stop/Snooze targeting and the snoozed
 * "Cancel" button. Regression: during snooze nothing is vibrating, so Cancel
 * built its targets from leftAlarmActive/rightAlarmActive (both false), fired
 * no clearAlarm, and the alarm resumed.
 */

import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const clearMutate = vi.fn()
  const snoozeMutate = vi.fn()
  return {
    clearMutate,
    snoozeMutate,
    trpc: {
      device: {
        clearAlarm: { useMutation: () => ({ mutate: clearMutate, isPending: false }) },
        snoozeAlarm: { useMutation: () => ({ mutate: snoozeMutate, isPending: false }) },
      },
    },
  }
})

const sideMock = vi.hoisted(() => ({
  activeSides: ['left', 'right'] as string[],
}))

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))
vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({ activeSides: sideMock.activeSides }),
}))

import { AlarmBanner } from '../AlarmBanner'

beforeEach(() => {
  trpcMock.clearMutate.mockClear()
  trpcMock.snoozeMutate.mockClear()
  sideMock.activeSides = ['left', 'right']
})

const futureSnooze = { active: true, snoozeUntil: Math.floor(Date.now() / 1000) + 240 }

describe('AlarmBanner', () => {
  it('renders nothing when no alarm is active and nothing is snoozed', () => {
    const { container } = render(
      <AlarmBanner leftAlarmActive={false} rightAlarmActive={false} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('Stop clears the actively vibrating sides', () => {
    const { getByText } = render(
      <AlarmBanner leftAlarmActive rightAlarmActive={false} />,
    )
    fireEvent.click(getByText('Stop'))
    expect(trpcMock.clearMutate).toHaveBeenCalledTimes(1)
    expect(trpcMock.clearMutate).toHaveBeenCalledWith({ side: 'left' }, expect.anything())
  })

  it('Cancel during snooze clears the snoozed side (regression: was a no-op)', () => {
    const { getByText } = render(
      <AlarmBanner
        leftAlarmActive={false}
        rightAlarmActive={false}
        snooze={{ left: futureSnooze, right: null }}
      />,
    )
    fireEvent.click(getByText('Cancel'))
    expect(trpcMock.clearMutate).toHaveBeenCalledTimes(1)
    expect(trpcMock.clearMutate).toHaveBeenCalledWith({ side: 'left' }, expect.anything())
  })

  it('Cancel clears every snoozed side when both are snoozed', () => {
    const { getByText } = render(
      <AlarmBanner
        leftAlarmActive={false}
        rightAlarmActive={false}
        snooze={{ left: futureSnooze, right: futureSnooze }}
      />,
    )
    fireEvent.click(getByText('Cancel'))
    expect(trpcMock.clearMutate).toHaveBeenCalledTimes(2)
    expect(trpcMock.clearMutate).toHaveBeenCalledWith({ side: 'left' }, expect.anything())
    expect(trpcMock.clearMutate).toHaveBeenCalledWith({ side: 'right' }, expect.anything())
  })

  it('Cancel targets the snoozed side even when activeSides shows only the other side', () => {
    sideMock.activeSides = ['left']
    const { getByText } = render(
      <AlarmBanner
        leftAlarmActive={false}
        rightAlarmActive={false}
        snooze={{ left: null, right: futureSnooze }}
      />,
    )
    fireEvent.click(getByText('Cancel'))
    expect(trpcMock.clearMutate).toHaveBeenCalledTimes(1)
    expect(trpcMock.clearMutate).toHaveBeenCalledWith({ side: 'right' }, expect.anything())
  })

  it('Snooze targets the vibrating side', () => {
    const { getByText } = render(
      <AlarmBanner leftAlarmActive={false} rightAlarmActive />,
    )
    fireEvent.click(getByText('Snooze 5m'))
    expect(trpcMock.snoozeMutate).toHaveBeenCalledTimes(1)
    expect(trpcMock.snoozeMutate).toHaveBeenCalledWith(
      { side: 'right', duration: 300 },
      expect.anything(),
    )
  })
})
