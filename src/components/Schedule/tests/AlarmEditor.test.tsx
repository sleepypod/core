import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlarmGroup } from '../AlarmCard'
import { AlarmEditor, SAVE_DELAY_MS } from '../AlarmEditor'

const m = vi.hoisted(() => ({
  batch: { mutateAsync: vi.fn(), isPending: false },
  setAlarm: { mutateAsync: vi.fn(), isPending: false, error: null as Error | null },
  clearAlarm: { mutate: vi.fn(), isPending: false },
  invalidate: vi.fn(),
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    schedules: { batchUpdate: { useMutation: () => m.batch } },
    device: { setAlarm: { useMutation: () => m.setAlarm }, clearAlarm: { useMutation: () => m.clearAlarm } },
    useUtils: () => ({ schedules: { getAll: { invalidate: m.invalidate }, getByDay: { invalidate: m.invalidate } } }),
  },
}))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Jon', rightName: 'Heidi' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
const single = vi.hoisted(() => ({ side: null as 'left' | 'right' | null }))
vi.mock('@/src/providers/SideProvider', () => ({ useSingleSleeperSide: () => single.side }))

const group: AlarmGroup = {
  ids: [11, 12],
  days: ['saturday', 'sunday'],
  time: '08:00',
  vibrationIntensity: 40,
  vibrationPattern: 'double',
  duration: 60,
  alarmTemperature: 84,
  wakeWindow: 20,
  snoozeDuration: 120,
  snoozeTaper: 30,
  enabled: false,
}

beforeEach(() => {
  m.batch.mutateAsync.mockReset().mockResolvedValue({ success: true, created: { temperature: [], power: [], alarm: [101, 102] } })
  m.batch.isPending = false
  m.setAlarm.mutateAsync.mockReset().mockResolvedValue(undefined)
  m.setAlarm.error = null
  m.clearAlarm.mutate.mockReset()
  m.invalidate.mockReset()
})
afterEach(cleanup)

// Done saves a waiting change at once and closes.
const done = (s: ReturnType<typeof render>) => fireEvent.click(s.getByRole('button', { name: 'Done' }))

describe('AlarmEditor', () => {
  it('saves a new alarm as soon as it has a day, without a save button', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const s = render(<AlarmEditor open onClose={onClose} onSaved={onSaved} side="left" />)
    expect(s.getByText('New alarm')).toBeTruthy()
    expect(s.queryByRole('button', { name: 'Save alarm' })).toBeNull()
    expect(s.getByText('Pick a day to save')).toBeTruthy()

    fireEvent.click(s.getByRole('button', { name: 'Weekdays' }))
    expect(s.getByRole('button', { name: 'Weekdays' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(s.getByLabelText('Wake at'), { target: { value: '06:45' } })
    expect(s.getByText('6:45')).toBeTruthy()

    // One save once the changes settle, and the editor stays open.
    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalledTimes(1))
    const payload = m.batch.mutateAsync.mock.calls[0][0]
    expect(payload.deletes).toEqual({ alarm: [] })
    expect(payload.creates.alarm).toHaveLength(5)
    expect(payload.creates.alarm[0]).toEqual({
      side: 'left',
      dayOfWeek: 'monday',
      time: '06:45',
      vibrationIntensity: 100,
      vibrationPattern: 'rise',
      duration: 30,
      alarmTemperature: 75,
      wakeWindow: 0,
      snoozeDuration: 300,
      snoozeTaper: 0,
      enabled: true,
    })
    expect(payload.creates.alarm.map((a: { dayOfWeek: string }) => a.dayOfWeek)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
    await waitFor(() => expect(s.getByText('Saved')).toBeTruthy())
    expect(onSaved).toHaveBeenCalled()
    expect(m.invalidate).toHaveBeenCalledTimes(2)
    expect(onClose).not.toHaveBeenCalled()

    // Done with nothing new to save just closes.
    done(s)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(m.batch.mutateAsync).toHaveBeenCalledTimes(1)
  })

  it('does not save an alarm that is opened and closed unchanged', async () => {
    const onClose = vi.fn()
    const s = render(<AlarmEditor open onClose={onClose} side="left" existingGroup={group} />)
    done(s)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, SAVE_DELAY_MS + 50))
    expect(m.batch.mutateAsync).not.toHaveBeenCalled()
  })

  it('each save replaces the rows the previous one created', async () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} />)
    fireEvent.click(s.getByRole('button', { name: 'Increase bed temperature at wake' }))
    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalledTimes(1))
    expect(m.batch.mutateAsync.mock.calls[0][0].deletes).toEqual({ alarm: [11, 12] })

    m.batch.mutateAsync.mockResolvedValue({ success: true, created: { temperature: [], power: [], alarm: [201, 202] } })
    fireEvent.click(s.getByRole('button', { name: 'Increase bed temperature at wake' }))
    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalledTimes(2))
    expect(m.batch.mutateAsync.mock.calls[1][0].deletes).toEqual({ alarm: [101, 102] })
    expect(m.batch.mutateAsync.mock.calls[1][0].creates.alarm[0].alarmTemperature).toBe(86)
  })

  it('the alarm coming back with its new rows does not reset an edit in progress', async () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} />)
    fireEvent.click(s.getByRole('button', { name: 'Increase bed temperature at wake' }))
    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalledTimes(1))
    fireEvent.click(s.getByRole('button', { name: 'Increase bed temperature at wake' }))
    // The parent refetches: the same alarm, now on the rows the save created.
    s.rerender(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={{ ...group, ids: [102, 101], alarmTemperature: 85 }} />)
    expect(s.getByText('86°')).toBeTruthy()
  })

  it('edits an existing group: replaces its rows, keeps paused state and writes both sides', async () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} />)
    expect(s.getByText('Edit alarm')).toBeTruthy()
    expect(s.getByRole('button', { name: 'Weekends' }).getAttribute('aria-pressed')).toBe('true')
    expect(s.getByRole('tab', { name: 'Double' }).getAttribute('aria-selected')).toBe('true')
    expect(s.getByText('40%')).toBeTruthy()
    expect(s.getByText('60 s')).toBeTruthy()
    expect(s.getByText('84°')).toBeTruthy()

    fireEvent.click(s.getByRole('tab', { name: 'Both' }))
    fireEvent.click(s.getByRole('tab', { name: 'Rise' }))
    fireEvent.change(s.getByLabelText('Vibration intensity'), { target: { value: '70' } })
    fireEvent.change(s.getByLabelText('Vibration duration'), { target: { value: '90' } })
    fireEvent.click(s.getByRole('button', { name: 'Increase bed temperature at wake' }))
    done(s)

    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
    // Done saved straight away, as one save.
    expect(m.batch.mutateAsync).toHaveBeenCalledTimes(1)
    const payload = m.batch.mutateAsync.mock.calls[0][0]
    expect(payload.deletes).toEqual({ alarm: [11, 12] })
    expect(payload.creates.alarm).toHaveLength(4)
    expect(payload.creates.alarm.map((a: { side: string }) => a.side)).toEqual(['left', 'left', 'right', 'right'])
    expect(payload.creates.alarm[0]).toMatchObject({
      time: '08:00',
      vibrationIntensity: 70,
      vibrationPattern: 'rise',
      duration: 90,
      alarmTemperature: 85,
      wakeWindow: 20,
      snoozeDuration: 120,
      snoozeTaper: 30,
      enabled: false,
    })
  })

  it('keeps edits when the parent passes an identical group again', async () => {
    // The home screen rebuilds the group on every render.
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} />)
    fireEvent.click(s.getByRole('button', { name: 'Decrease bed temperature at wake' }))
    fireEvent.click(s.getByRole('button', { name: 'Decrease bed temperature at wake' }))
    expect(s.getByText('82°')).toBeTruthy()
    s.rerender(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={{ ...group, days: [...group.days] }} />)
    expect(s.getByText('82°')).toBeTruthy()
    done(s)
    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
    expect(m.batch.mutateAsync.mock.calls[0][0].creates.alarm[0].alarmTemperature).toBe(82)
  })

  it('reloads for a different alarm, and on reopening', () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} />)
    fireEvent.click(s.getByRole('button', { name: 'Decrease bed temperature at wake' }))
    expect(s.getByText('83°')).toBeTruthy()
    s.rerender(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={{ ...group, ids: [21], alarmTemperature: 70 }} />)
    expect(s.getByText('70°')).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Increase bed temperature at wake' }))
    s.rerender(<AlarmEditor open={false} onClose={vi.fn()} side="left" existingGroup={{ ...group, ids: [21], alarmTemperature: 70 }} />)
    s.rerender(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={{ ...group, ids: [21], alarmTemperature: 70 }} />)
    expect(s.getByText('70°')).toBeTruthy()
  })

  it('puts alarms on the sleeper\'s side, without a side picker, when the other side is away', async () => {
    single.side = 'right'
    try {
      const s = render(<AlarmEditor open onClose={vi.fn()} side="left" defaultSide="both" />)
      expect(s.queryByRole('tablist', { name: 'Alarm side' })).toBeNull()
      fireEvent.click(s.getByRole('button', { name: 'Weekdays' }))
      done(s)
      await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
      const sides = m.batch.mutateAsync.mock.calls[0][0].creates.alarm.map((a: { side: string }) => a.side)
      expect(new Set(sides)).toEqual(new Set(['right']))
    }
    finally {
      single.side = null
    }
  })

  it('shows and saves the wake window', async () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} />)
    const wakeWindow = within(s.getByRole('tablist', { name: 'Wake window' }))
    expect(wakeWindow.getByRole('tab', { name: '20' }).getAttribute('aria-selected')).toBe('true')
    expect(s.getByText(/up to 20 min early, the first time you move after 7:40 AM\. Otherwise it goes off at 8:00 AM/)).toBeTruthy()

    fireEvent.click(wakeWindow.getByRole('tab', { name: '30 min' }))
    expect(s.getByText(/up to 30 min early, the first time you move after 7:30 AM/)).toBeTruthy()
    done(s)
    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
    expect(m.batch.mutateAsync.mock.calls[0][0].creates.alarm[0].wakeWindow).toBe(30)
  })

  it('wraps the window start across midnight and turns off', async () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={{ ...group, time: '00:10' }} />)
    expect(s.getByText(/first time you move after 11:50 PM/)).toBeTruthy()
    fireEvent.click(within(s.getByRole('tablist', { name: 'Wake window' })).getByRole('tab', { name: 'Off' }))
    expect(s.getByText('Goes off at the set time.')).toBeTruthy()
    done(s)
    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
    expect(m.batch.mutateAsync.mock.calls[0][0].creates.alarm[0].wakeWindow).toBe(0)
  })

  it('shows and saves the snooze length and Snooze taper', async () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} />)
    const taper = within(s.getByRole('tablist', { name: 'Snooze taper' }))
    expect(taper.getByRole('tab', { name: '30' }).getAttribute('aria-selected')).toBe('true')
    expect(taper.queryByRole('tab', { name: '20' })).toBeNull()
    expect(s.getByText(/Each snooze is 30% shorter than the last.*: 2, 1\.4, 1, 0\.7 min…$/)).toBeTruthy()

    fireEvent.click(taper.getByRole('tab', { name: '50' }))
    fireEvent.click(s.getByRole('button', { name: /Increase snooze length/i }))
    expect(s.getByText(/Each snooze is 50% shorter than the last.*: 3, 1\.5, 0\.8, 0\.4 min…$/)).toBeTruthy()
    done(s)
    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
    expect(m.batch.mutateAsync.mock.calls[0][0].creates.alarm[0]).toMatchObject({ snoozeDuration: 180, snoozeTaper: 50 })
  })

  it('a new alarm snoozes 5 minutes with no taper', async () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" />)
    expect(s.getByText('Every snooze lasts 5 min. Snooze taper makes each one shorter than the last.')).toBeTruthy()
  })

  it('surfaces save failures and stays open', async () => {
    m.batch.mutateAsync.mockRejectedValue(new Error('db locked'))
    const onClose = vi.fn()
    const s = render(<AlarmEditor open onClose={onClose} side="right" existingGroup={group} />)
    fireEvent.click(s.getByRole('button', { name: 'Increase bed temperature at wake' }))
    done(s)
    await waitFor(() => expect(s.getByText('db locked')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('routes Delete to the parent confirmation instead of deleting directly', async () => {
    const onRequestDelete = vi.fn()
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} onRequestDelete={onRequestDelete} />)
    fireEvent.click(s.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onRequestDelete).toHaveBeenCalledWith(group))
    expect(m.batch.mutateAsync).not.toHaveBeenCalled()
  })

  it('deletes the rows the latest save created', async () => {
    const onRequestDelete = vi.fn()
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} onRequestDelete={onRequestDelete} />)
    fireEvent.click(s.getByRole('button', { name: 'Increase bed temperature at wake' }))
    fireEvent.click(s.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onRequestDelete).toHaveBeenCalledWith(expect.objectContaining({ ids: [101, 102] })))
  })

  it('hides Delete for new alarms', () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" onRequestDelete={vi.fn()} />)
    expect(s.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('tests the current vibration on every chosen side, then offers Stop', async () => {
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" defaultSide="both" existingGroup={null} />)
    fireEvent.click(s.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(s.getByRole('button', { name: 'Stop' })).toBeTruthy())
    expect(m.setAlarm.mutateAsync).toHaveBeenCalledTimes(2)
    expect(m.setAlarm.mutateAsync).toHaveBeenCalledWith({ side: 'left', vibrationIntensity: 100, vibrationPattern: 'rise', duration: 30 })
    expect(m.setAlarm.mutateAsync).toHaveBeenCalledWith({ side: 'right', vibrationIntensity: 100, vibrationPattern: 'rise', duration: 30 })
    fireEvent.click(s.getByRole('button', { name: 'Stop' }))
    expect(m.clearAlarm.mutate).toHaveBeenCalledWith({ side: 'left' })
    expect(m.clearAlarm.mutate).toHaveBeenCalledWith({ side: 'right' })
    expect(s.getByRole('button', { name: 'Test' })).toBeTruthy()
  })

  it('keeps Test available when the test call fails', async () => {
    m.setAlarm.mutateAsync.mockRejectedValue(new Error('offline'))
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" />)
    fireEvent.click(s.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(m.setAlarm.mutateAsync).toHaveBeenCalled())
    expect(s.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('renders nothing when closed', () => {
    const s = render(<AlarmEditor open={false} onClose={vi.fn()} side="left" />)
    expect(s.queryByRole('dialog')).toBeNull()
  })
})

it('selects individual repeat days and saves precisely that selection', async () => {
  const s = render(<AlarmEditor open onClose={vi.fn()} side="left" />)
  fireEvent.click(s.getByRole('button', { name: 'Mon' }))
  done(s)
  await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
  expect(m.batch.mutateAsync.mock.calls[0][0].creates.alarm).toEqual([expect.objectContaining({ dayOfWeek: 'monday' })])
})

it.each([90, 61, 1799])('preserves a %s-second snooze when editing only alarm time', async (snoozeDuration) => {
  const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={{ ...group, snoozeDuration }} />)
  fireEvent.change(s.getByLabelText('Wake at'), { target: { value: '08:30' } })
  done(s)
  await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
  expect(m.batch.mutateAsync.mock.calls[0][0].creates.alarm[0].snoozeDuration).toBe(snoozeDuration)
})
it('increments a fractional-minute snooze by one minute when explicitly changed', async () => {
  const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={{ ...group, snoozeDuration: 90 }} />)
  expect(s.getByText('1.5 min')).toBeTruthy()
  fireEvent.click(s.getByRole('button', { name: 'Increase snooze length' }))
  expect(s.getByText('2.5 min')).toBeTruthy()
  done(s)
  await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
  expect(m.batch.mutateAsync.mock.calls[0][0].creates.alarm[0].snoozeDuration).toBe(150)
})
