import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlarmGroup } from '../AlarmCard'
import { AlarmEditor } from '../AlarmEditor'

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
  enabled: false,
}

beforeEach(() => {
  m.batch.mutateAsync.mockReset().mockResolvedValue(undefined)
  m.batch.isPending = false
  m.setAlarm.mutateAsync.mockReset().mockResolvedValue(undefined)
  m.setAlarm.error = null
  m.clearAlarm.mutate.mockReset()
  m.invalidate.mockReset()
})
afterEach(cleanup)

const saveButton = (s: ReturnType<typeof render>) => s.getByRole('button', { name: 'Save alarm' }) as HTMLButtonElement

describe('AlarmEditor', () => {
  it('creates one row per day for a new alarm and closes', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const s = render(<AlarmEditor open onClose={onClose} onSaved={onSaved} side="left" />)
    expect(s.getByText('New alarm')).toBeTruthy()
    expect(saveButton(s).disabled).toBe(true)

    fireEvent.click(s.getByRole('button', { name: 'Weekdays' }))
    expect(s.getByRole('button', { name: 'Weekdays' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(s.getByLabelText('Wake at'), { target: { value: '06:45' } })
    expect(s.getByText('6:45')).toBeTruthy()
    fireEvent.click(saveButton(s))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
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
      enabled: true,
    })
    expect(payload.creates.alarm.map((a: { dayOfWeek: string }) => a.dayOfWeek)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
    expect(onSaved).toHaveBeenCalled()
    expect(m.invalidate).toHaveBeenCalledTimes(2)
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
    fireEvent.click(saveButton(s))

    await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
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
    fireEvent.click(saveButton(s))
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
      fireEvent.click(saveButton(s))
      await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
      const sides = m.batch.mutateAsync.mock.calls[0][0].creates.alarm.map((a: { side: string }) => a.side)
      expect(new Set(sides)).toEqual(new Set(['right']))
    }
    finally {
      single.side = null
    }
  })

  it('surfaces save failures and stays open', async () => {
    m.batch.mutateAsync.mockRejectedValue(new Error('db locked'))
    const onClose = vi.fn()
    const s = render(<AlarmEditor open onClose={onClose} side="right" existingGroup={group} />)
    fireEvent.click(saveButton(s))
    await waitFor(() => expect(s.getByText('db locked')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('routes Delete to the parent confirmation instead of deleting directly', () => {
    const onRequestDelete = vi.fn()
    const s = render(<AlarmEditor open onClose={vi.fn()} side="left" existingGroup={group} onRequestDelete={onRequestDelete} />)
    fireEvent.click(s.getByRole('button', { name: 'Delete' }))
    expect(onRequestDelete).toHaveBeenCalledWith(group)
    expect(m.batch.mutateAsync).not.toHaveBeenCalled()
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
  fireEvent.click(saveButton(s))
  await waitFor(() => expect(m.batch.mutateAsync).toHaveBeenCalled())
  expect(m.batch.mutateAsync.mock.calls[0][0].creates.alarm).toEqual([expect.objectContaining({ dayOfWeek: 'monday' })])
})
