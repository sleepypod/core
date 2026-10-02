/**
 * TapGestureConfig — row descriptions for idle vs ringing, and the editor
 * save / remove payloads.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const setMutate = vi.fn()
  const deleteMutate = vi.fn()
  const state = { gestures: { left: [] as unknown[], right: [] as unknown[] } }
  return {
    setMutate,
    deleteMutate,
    state,
    trpc: {
      useUtils: () => ({ settings: { getAll: { invalidate: vi.fn() } } }),
      settings: {
        getAll: { useQuery: () => ({ data: { gestures: state.gestures, sides: {} }, isLoading: false, error: null }) },
        setGesture: { useMutation: () => ({ mutate: setMutate, isPending: false, error: null }) },
        deleteGesture: { useMutation: () => ({ mutate: deleteMutate, isPending: false, error: null }) },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { idleDescription, ringingDescription, TapGestureConfig } from '../TapGestureConfig'

const gesture = (overrides: Record<string, unknown>) => ({
  id: 1,
  side: 'left',
  tapType: 'doubleTap',
  actionType: 'temperature',
  temperatureChange: 'increment',
  temperatureAmount: 2,
  alarmBehavior: null,
  alarmSnoozeDuration: null,
  alarmInactiveBehavior: null,
  ...overrides,
}) as Parameters<typeof idleDescription>[0]

beforeEach(() => {
  trpcMock.setMutate.mockClear()
  trpcMock.deleteMutate.mockClear()
  trpcMock.state.gestures = { left: [], right: [] }
})

describe('gesture descriptions', () => {
  it('describes unset gestures', () => {
    expect(idleDescription(undefined)).toBe('Not set')
    expect(ringingDescription(undefined)).toBe('Not set')
  })

  it('shows temperature changes the same in both contexts', () => {
    expect(idleDescription(gesture({}))).toBe('Temperature +2°')
    expect(ringingDescription(gesture({ temperatureChange: 'decrement', temperatureAmount: 1 }))).toBe('Temperature −1°')
  })

  it('describes alarm gestures by context', () => {
    const snooze = gesture({ actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 420, alarmInactiveBehavior: 'power' })
    expect(ringingDescription(snooze)).toBe('Snooze 7 min')
    expect(idleDescription(snooze)).toBe('Power on / off')
    const dismiss = gesture({ actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'none' })
    expect(ringingDescription(dismiss)).toBe('Stop alarm')
    expect(idleDescription(dismiss)).toBe('Nothing')
  })
})

describe('TapGestureConfig', () => {
  it('saves a new temperature gesture with the default payload', () => {
    render(<TapGestureConfig filterSide="right" />)
    fireEvent.click(screen.getByLabelText('Triple tap: Not set'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'right',
      tapType: 'tripleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 2,
    })
  })

  it('saves an alarm gesture, omitting snooze duration when dismissing', () => {
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Quad tap while ringing: Not set'))
    fireEvent.click(screen.getByText('Alarm & power'))
    fireEvent.click(screen.getByText('Stop alarm'))
    fireEvent.click(screen.getByText('Power on / off'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      tapType: 'quadTap',
      actionType: 'alarm',
      alarmBehavior: 'dismiss',
      alarmSnoozeDuration: undefined,
      alarmInactiveBehavior: 'power',
    })
  })

  it('removes an existing gesture', () => {
    trpcMock.state.gestures = { left: [gesture({})], right: [] }
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Double tap: Temperature +2°'))
    fireEvent.click(screen.getByText('Remove'))
    expect(trpcMock.deleteMutate).toHaveBeenCalledWith({ side: 'left', tapType: 'doubleTap' })
  })

  it('offers Remove only for gestures that exist', () => {
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Double tap: Not set'))
    expect(screen.queryByText('Remove')).toBeNull()
  })
})
