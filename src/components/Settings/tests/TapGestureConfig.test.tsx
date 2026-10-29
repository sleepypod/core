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

  it('describes the normal and ringing actions independently', () => {
    expect(idleDescription(gesture({}))).toBe('Temperature +2°')
    // A temperature tap with no ringing action stops the alarm (the firmware does on any tap).
    expect(ringingDescription(gesture({}))).toBe('Stop alarm')
    expect(ringingDescription(gesture({ alarmBehavior: 'snooze', alarmSnoozeDuration: 420 }))).toBe('Snooze')
    expect(idleDescription(gesture({ alarmBehavior: 'snooze' }))).toBe('Temperature +2°')
  })

  it('describes alarm-type gestures by context', () => {
    const snooze = gesture({ actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 420, alarmInactiveBehavior: 'power' })
    expect(ringingDescription(snooze)).toBe('Snooze')
    expect(idleDescription(snooze)).toBe('Power on / off')
    const dismiss = gesture({ actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'none' })
    expect(ringingDescription(dismiss)).toBe('Stop alarm')
    expect(idleDescription(dismiss)).toBe('Nothing')
  })
})

describe('TapGestureConfig', () => {
  it('saves a new gesture: +2° normally, stop the alarm while ringing', () => {
    render(<TapGestureConfig filterSide="right" />)
    fireEvent.click(screen.getByLabelText('Triple tap: Not set'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'right',
      tapType: 'tripleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 2,
      alarmBehavior: 'dismiss',
    })
  })

  it('changing the ringing action keeps the normal temperature action', () => {
    trpcMock.state.gestures = { left: [gesture({ temperatureAmount: 3 })], right: [] }
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Double tap while ringing: Stop alarm'))
    fireEvent.click(screen.getByText('Snooze'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 3,
      alarmBehavior: 'snooze',
    })
  })

  it('changing the normal action keeps the ringing action', () => {
    trpcMock.state.gestures = { left: [gesture({ alarmBehavior: 'snooze', alarmSnoozeDuration: 420 })], right: [] }
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Double tap: Temperature +2°'))
    fireEvent.click(screen.getByText('Power on / off'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'alarm',
      alarmBehavior: 'snooze',
      alarmInactiveBehavior: 'power',
    })
  })

  it('leaves the snooze length to the alarm', () => {
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Double tap while ringing: Not set'))
    fireEvent.click(screen.getByText('Snooze'))
    expect(screen.getByText('How long a snooze lasts is set on each alarm.')).toBeTruthy()
    expect(screen.queryByLabelText(/snooze duration/i)).toBeNull()
  })

  it('a new tap opened from the ringing column gets no normal action', () => {
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Quad tap while ringing: Not set'))
    fireEvent.click(screen.getByText('Snooze'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      tapType: 'quadTap',
      actionType: 'alarm',
      alarmBehavior: 'snooze',
      alarmInactiveBehavior: 'none',
    })
  })

  it('saves nothing normally and stop while ringing', () => {
    render(<TapGestureConfig filterSide="left" />)
    fireEvent.click(screen.getByLabelText('Quad tap: Not set'))
    fireEvent.click(screen.getByText('Nothing'))
    fireEvent.click(screen.getByText('Stop alarm'))
    fireEvent.click(screen.getByText('Save'))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      tapType: 'quadTap',
      actionType: 'alarm',
      alarmBehavior: 'dismiss',
      alarmInactiveBehavior: 'none',
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
