import { renderToString } from 'react-dom/server'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CurveEditor } from '../CurveEditor'

interface Curve { id: number, name: string, days: { left: string[], right: string[] }, active: boolean }

const m = vi.hoisted(() => ({
  put: vi.fn(),
  isSaving: false,
  templates: [] as Curve[],
  side: { selectedSide: 'left' as string, singleScheduleSide: null as string | null },
}))
vi.mock('@/src/hooks/useCurveTemplates', () => ({
  useCurveTemplates: () => ({ templates: m.templates, put: m.put, isSaving: m.isSaving, save: vi.fn() }),
}))
vi.mock('@/src/providers/SideProvider', () => ({ useSide: () => m.side }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Jon', rightName: 'Heidi' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))

const INITIAL = [
  { time: '07:00', temperature: 84 },
  { time: '23:15', temperature: 83 },
  { time: '00:30', temperature: 79 },
]

const WEEKNIGHT: Curve = { id: 7, name: 'Weeknight', days: { left: ['monday', 'saturday'], right: [] }, active: true }

beforeEach(() => {
  m.put.mockReset().mockResolvedValue({ curve: {}, moved: [] })
  m.isSaving = false
  m.templates = []
  m.side.selectedSide = 'left'
  m.side.singleScheduleSide = null
})
afterEach(cleanup)

const saveCurveButton = (s: ReturnType<typeof render>) => s.getByRole('button', { name: 'Save curve' }) as HTMLButtonElement
const rows = (s: ReturnType<typeof render>) => s.queryAllByTestId('set-point-row')
const saved = () => m.put.mock.calls[0][0]

describe('CurveEditor', () => {
  it('creates a curve from a preset for the picked days', async () => {
    const onClose = vi.fn()
    const s = render(<CurveEditor onClose={onClose} />)
    expect(s.getAllByText('New curve').length).toBeGreaterThan(0)
    expect(s.getByText('Start from a preset or add set points manually')).toBeTruthy()
    expect(saveCurveButton(s).disabled).toBe(true)

    fireEvent.click(s.getByRole('button', { name: 'Mon' }))
    fireEvent.click(s.getByRole('button', { name: 'Tue' }))
    fireEvent.click(s.getByRole('button', { name: /Balanced/ }))
    expect(s.getByRole('button', { name: /Balanced/ }).getAttribute('aria-pressed')).toBe('true')
    expect(rows(s).length).toBeGreaterThan(2)
    expect(s.getByText('Jon · Mon, Tue')).toBeTruthy()
    expect(s.getByText('Other curves keep their days.')).toBeTruthy()
    expect(saveCurveButton(s).disabled).toBe(false)

    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const arg = saved()
    expect(arg).toMatchObject({ id: undefined, name: 'Mon, Tue curve', days: { left: ['monday', 'tuesday'], right: [] }, active: true, endAction: 'turn_off' })
    expect(Object.keys(arg.points)).toHaveLength(rows(s).length)
    for (const t of Object.values(arg.points) as number[]) {
      expect(t).toBeGreaterThanOrEqual(55)
      expect(t).toBeLessThanOrEqual(110)
    }
  })

  it('lists set points chronologically with power on/off labels and edits them', async () => {
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    expect(s.getAllByText('Edit curve').length).toBeGreaterThan(0)
    const list = rows(s)
    expect(list.map(r => within(r).getByRole('button', { name: /Edit set point/ }).textContent)).toEqual(['11:15 PM', '12:30 AM', '7:00 AM'])
    expect(within(list[0]).getByText('Power on')).toBeTruthy()
    expect(within(list[2]).getByText('Power off')).toBeTruthy()
    expect(within(list[1]).queryByText(/Power/)).toBeNull()

    fireEvent.click(s.getByRole('button', { name: 'Increase temperature at 11:15 PM' }))
    fireEvent.click(s.getByRole('button', { name: 'Delete set point 12:30 AM' }))
    expect(rows(s)).toHaveLength(2)

    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(saved()).toEqual({
      id: undefined,
      name: 'Mon curve',
      bedtime: '23:15',
      wake: '07:00',
      points: { '23:15': 84, '07:00': 84 },
      notes: '',
      endAction: 'turn_off',
      days: { left: ['monday'], right: [] },
      active: true,
    })
  })

  it('opens without the rows inside a flat hold', () => {
    const held = [
      { time: '23:00', temperature: 80 },
      { time: '00:00', temperature: 77 },
      { time: '01:00', temperature: 77 },
      { time: '02:00', temperature: 77 },
      { time: '06:00', temperature: 77 },
      { time: '07:00', temperature: 82 },
    ]
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={held} />)
    expect(rows(s).map(r => within(r).getByRole('button', { name: /Edit set point/ }).textContent))
      .toEqual(['11:00 PM', '12:00 AM', '6:00 AM', '7:00 AM'])
  })

  it('adds a set point through the set-point dialog', () => {
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(s.getByRole('button', { name: 'Add set point' }))
    const dialog = s.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '03:00' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add set point' }))
    expect(s.queryByRole('dialog')).toBeNull()
    expect(rows(s).map(r => within(r).getByRole('button', { name: /Edit set point/ }).textContent))
      .toEqual(['11:15 PM', '12:30 AM', '3:00 AM', '7:00 AM'])
  })

  it('asks before moving days that another active curve runs, then saves', async () => {
    m.templates = [WEEKNIGHT]
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    expect(s.getByText('Mon moves from Weeknight.')).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Sat' }))
    expect(s.getByText('Mon, Sat move from Weeknight, which turns off.')).toBeTruthy()
    fireEvent.click(saveCurveButton(s))
    const dialog = await waitFor(() => s.getByRole('dialog'))
    expect(within(dialog).getByText('Mon, Sat move from Weeknight, which turns off. Saving moves them to this curve.')).toBeTruthy()
    expect(m.put).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move & save' }))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(saved().days).toEqual({ left: ['monday', 'saturday'], right: [] })
  })

  it('does not ask when the curve is saved without running', async () => {
    m.templates = [WEEKNIGHT]
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(s.getByRole('switch', { name: 'Run on these days' }))
    expect(s.getByText('Saved to your curves without running. Turn it on any time.')).toBeTruthy()
    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(s.queryByRole('dialog')).toBeNull()
    expect(saved()).toMatchObject({ active: false, days: { left: ['monday'], right: [] } })
  })

  it('ignores its own days and inactive curves when looking for moves', () => {
    m.templates = [{ ...WEEKNIGHT, active: false }, { id: 3, name: 'Mine', days: { left: ['monday'], right: [] }, active: true }]
    const s = render(<CurveEditor onClose={vi.fn()} curveId={3} initialName="Mine" initialDays={['monday']} initialSetPoints={INITIAL} />)
    expect(s.getByText('Other curves keep their days.')).toBeTruthy()
  })

  it('saves to the library without days, explaining it will not run', async () => {
    const s = render(<CurveEditor onClose={vi.fn()} initialSetPoints={INITIAL} />)
    expect(s.getByText('Pick days to run it. Without days it is saved without running.')).toBeTruthy()
    expect((s.getByLabelText('Name') as HTMLInputElement).placeholder).toBe('New curve')
    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(saved()).toMatchObject({ name: 'New curve', days: { left: [], right: [] }, active: true })
  })

  it('needs at least two set points', async () => {
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={[{ time: '22:00', temperature: 80 }]} />)
    fireEvent.click(saveCurveButton(s))
    expect(await s.findByText('Add at least two set points')).toBeTruthy()
    expect(m.put).not.toHaveBeenCalled()
  })

  it('uses the typed name, or numbers the default when it is taken', async () => {
    m.templates = [
      { id: 1, name: 'Weekdays curve', days: { left: [], right: [] }, active: false },
      { id: 2, name: 'Weekdays curve 2', days: { left: [], right: [] }, active: false },
    ]
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={[...weekdays]} initialSetPoints={INITIAL} />)
    expect((s.getByLabelText('Name') as HTMLInputElement).placeholder).toBe('Weekdays curve')
    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(saved().name).toBe('Weekdays curve 3')
    cleanup()

    m.put.mockClear()
    const named = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.change(named.getByLabelText('Name'), { target: { value: '  Late warm  ' } })
    fireEvent.click(saveCurveButton(named))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(saved().name).toBe('Late warm')
  })

  it('edits a library curve in place, keeping the other side\'s days and its own name', async () => {
    m.templates = [{ id: 9, name: 'Weekdays curve', days: { left: ['monday'], right: ['friday'] }, active: true }]
    const s = render(
      <CurveEditor
        onClose={vi.fn()}
        curveId={9}
        initialName="Weekdays curve"
        initialActive
        curveDays={{ left: ['monday'], right: ['friday'] }}
        initialDays={['monday']}
        initialSetPoints={INITIAL}
      />,
    )
    expect(s.getAllByText('Edit curve').length).toBeGreaterThan(0)
    expect((s.getByLabelText('Name') as HTMLInputElement).value).toBe('Weekdays curve')
    fireEvent.click(s.getByRole('button', { name: 'Tue' }))
    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(saved()).toMatchObject({ id: 9, name: 'Weekdays curve', days: { left: ['monday', 'tuesday'], right: ['friday'] }, active: true })
  })

  it('writes the picked days to both sides in the Both view', async () => {
    m.side.selectedSide = 'both'
    const s = render(<CurveEditor onClose={vi.fn()} curveId={4} curveDays={{ left: ['monday'], right: ['sunday'] }} initialDays={['monday', 'sunday']} initialSetPoints={INITIAL} />)
    expect(s.getByText('Both sides · Mon, Sun')).toBeTruthy()
    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(saved().days).toEqual({ left: ['sunday', 'monday'], right: ['sunday', 'monday'] })
  })

  it('writes to the sleeper\'s side when the other side is away', async () => {
    m.side.selectedSide = 'both'
    m.side.singleScheduleSide = 'right'
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    expect(s.getByText('Heidi · Mon')).toBeTruthy()
    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(m.put).toHaveBeenCalled())
    expect(saved().days).toEqual({ left: [], right: ['monday'] })
  })

  it('shows save failures inline', async () => {
    m.put.mockRejectedValue(new Error('Another curve already has that name'))
    const onClose = vi.fn()
    const s = render(<CurveEditor onClose={onClose} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(saveCurveButton(s))
    await waitFor(() => expect(s.getByText('Another curve already has that name')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reports a generic failure for non-Error rejections and closes the move dialog', async () => {
    m.templates = [WEEKNIGHT]
    m.put.mockRejectedValue('nope')
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(saveCurveButton(s))
    fireEvent.click(within(await waitFor(() => s.getByRole('dialog'))).getByRole('button', { name: 'Move & save' }))
    await waitFor(() => expect(s.getByText('Save failed')).toBeTruthy())
    expect(s.queryByRole('dialog')).toBeNull()
  })

  it('shows saving state while the library write is pending', () => {
    m.isSaving = true
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
    const busy = s.getAllByRole('button', { name: /Saving…/ }) as HTMLButtonElement[]
    expect(busy.length).toBe(2)
    expect(busy.every(b => b.disabled)).toBe(true)
  })

  it('cancels without saving', () => {
    const onClose = vi.fn()
    const s = render(<CurveEditor onClose={onClose} initialDays={['monday']} initialSetPoints={INITIAL} />)
    fireEvent.click(s.getAllByRole('button', { name: 'Cancel' })[0])
    expect(onClose).toHaveBeenCalled()
    expect(m.put).not.toHaveBeenCalled()
  })

  it('keeps coolest at least 2° below warmest', () => {
    const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={[{ time: '22:00', temperature: 80 }, { time: '06:00', temperature: 82 }]} />)
    fireEvent.click(s.getByRole('button', { name: 'Increase coolest temperature' }))
    const coolest = s.getByRole('group', { name: 'coolest temperature' })
    expect(coolest.textContent).toContain('80°')
    fireEvent.click(s.getByRole('button', { name: 'Decrease warmest temperature' }))
    expect(s.getByRole('group', { name: 'warmest temperature' }).textContent).toContain('82°')
  })
})

it('updates a point from its dialog and keyboard chart, and can cancel a day move', () => {
  m.templates = [{ id: 7, name: 'Weeknight', days: { left: ['tuesday'], right: [] }, active: true }]
  const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
  fireEvent.click(s.getByRole('button', { name: 'Edit set point 11:15 PM' }))
  const dialog = s.getByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '22:00' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  expect(s.getByRole('button', { name: 'Edit set point 10:00 PM' })).toBeTruthy()
  fireEvent.keyDown(s.getAllByRole('slider')[0], { key: 'ArrowUp' })
  fireEvent.click(s.getByRole('button', { name: 'Tue' }))
  fireEvent.click(saveCurveButton(s))
  fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(s.queryByRole('dialog')).toBeNull()
  expect(m.put).not.toHaveBeenCalled()
})

it('loads an imported AI curve into the local editor and saves only after review', async () => {
  const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
  fireEvent.click(s.getByRole('button', { name: 'Custom AI curve' }))
  fireEvent.click(s.getByRole('button', { name: 'Import' }))
  fireEvent.change(s.getByLabelText('AI response JSON'), {
    target: { value: JSON.stringify({ name: 'Test AI curve', bedtime: '22:00', wake: '07:00', points: { '22:00': 80, '02:00': 75, '07:00': 82 }, reasoning: '' }) },
  })
  await waitFor(() => expect((s.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(s.getByRole('button', { name: 'Next' }))
  fireEvent.click(s.getByRole('button', { name: 'Use curve' }))
  expect(s.queryByRole('dialog')).toBeNull()
  expect(m.put).not.toHaveBeenCalled()
  expect(rows(s)).toHaveLength(3)
  fireEvent.click(saveCurveButton(s))
  await waitFor(() => expect(m.put).toHaveBeenCalledWith(expect.objectContaining({ points: { '22:00': 80, '02:00': 75, '07:00': 82 }, bedtime: '22:00', wake: '07:00' })))
})

it('edits the optional note and saves it with the curve', async () => {
  const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} initialNotes="Old note" />)
  const notes = s.getByLabelText(/Notes/) as HTMLTextAreaElement
  expect(notes.value).toBe('Old note')
  fireEvent.change(notes, { target: { value: 'Based on 14 nights' } })
  fireEvent.click(saveCurveButton(s))
  await waitFor(() => expect(m.put).toHaveBeenCalledWith(expect.objectContaining({ notes: 'Based on 14 nights' })))
})

it('subscribes to desktop layout changes and removes the listener on unmount', () => {
  let matches = true
  let change = () => {}
  const remove = vi.fn()
  vi.stubGlobal('matchMedia', () => ({ get matches() {
    return matches
  }, addEventListener: (_event: string, cb: () => void) => {
    change = cb
  }, removeEventListener: remove }))
  const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
  act(() => {
    matches = false
    change()
  })
  expect(s.getByRole('button', { name: 'Save curve' })).toBeTruthy()
  s.unmount()
  expect(remove).toHaveBeenCalledWith('change', change)
  vi.unstubAllGlobals()
})

it('renders the desktop editor during server rendering before media queries are available', () => {
  const html = renderToString(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} />)
  expect(html).toContain('Save curve')
  expect(html).toContain('Edit set point 11:15 PM')
})

it('preserves maintain on edit, removes the off badge, and saves the choice', async () => {
  const s = render(<CurveEditor onClose={vi.fn()} initialDays={['monday']} initialSetPoints={INITIAL} initialEndAction="maintain" />)
  expect((s.getByLabelText('After schedule ends') as HTMLSelectElement).value).toBe('maintain')
  expect(s.queryByText('Power off')).toBeNull()
  fireEvent.click(saveCurveButton(s))
  await waitFor(() => expect(m.put).toHaveBeenCalledWith(expect.objectContaining({ endAction: 'maintain' })))
  fireEvent.change(s.getByLabelText('After schedule ends'), { target: { value: 'turn_off' } })
  expect(s.getByText('Power off')).toBeTruthy()
})
