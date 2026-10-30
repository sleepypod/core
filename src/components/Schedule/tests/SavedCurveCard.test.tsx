import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))

import { curveDaysLabel, describeMoves, SavedCurveCard, templateSetPoints } from '../SavedCurveCard'
import type { SavedCurve } from '@/src/hooks/useCurveTemplates'

afterEach(cleanup)

const NAMES = { left: 'Jon', right: 'Heidi' }
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const
const CURVE: SavedCurve = {
  id: 3,
  name: 'Weeknight',
  bedtime: '23:15',
  wake: '07:00',
  points: { '23:15': 83, '00:30': 79, '07:00': 84 },
  notes: 'Cooler first half.',
  endAction: 'turn_off',
  days: { left: [...WEEKDAYS], right: [] },
  active: true,
  createdAt: 1,
}

describe('templateSetPoints', () => {
  it('lists a curve\'s stored points as set points', () => {
    expect(templateSetPoints({ points: { '22:00': 70, '06:00': 80 } })).toEqual([{ time: '22:00', temperature: 70 }, { time: '06:00', temperature: 80 }])
  })
})

describe('curveDaysLabel', () => {
  it('shows one side\'s days, or No days', () => {
    expect(curveDaysLabel(CURVE, ['left'], NAMES)).toBe('Mon–Fri')
    expect(curveDaysLabel(CURVE, ['right'], NAMES)).toBe('No days')
    expect(curveDaysLabel({ days: { left: [], right: [] } }, ['left', 'right'], NAMES)).toBe('No days')
  })

  it('names each side when showing both, and says Both when they match', () => {
    expect(curveDaysLabel(CURVE, ['left', 'right'], NAMES)).toBe('Jon Mon–Fri')
    expect(curveDaysLabel({ days: { left: ['monday'], right: ['saturday', 'sunday'] } }, ['left', 'right'], NAMES)).toBe('Jon Mon · Heidi Sat, Sun')
    expect(curveDaysLabel({ days: { left: [...WEEKDAYS], right: [...WEEKDAYS] } }, ['left', 'right'], NAMES)).toBe('Both · Mon–Fri')
  })
})

describe('describeMoves', () => {
  it('groups moves by curve, counts days for the verb and notes curves that turn off', () => {
    expect(describeMoves([{ id: 1, name: 'Weeknight', side: 'left', days: ['monday'], deactivated: false }], NAMES))
      .toBe('Mon moves from Weeknight')
    expect(describeMoves([
      { id: 1, name: 'Weeknight', side: 'left', days: ['monday', 'tuesday'], deactivated: false },
      { id: 2, name: 'Lazy Sunday', side: 'right', days: ['sunday'], deactivated: true },
    ], NAMES)).toBe('Mon, Tue move from Weeknight; Sun moves from Lazy Sunday, which turns off')
  })

  it('names the sides when one curve gives up days on both', () => {
    expect(describeMoves([
      { id: 1, name: 'Shared', side: 'left', days: ['saturday'], deactivated: false },
      { id: 1, name: 'Shared', side: 'right', days: ['saturday'], deactivated: false },
    ], NAMES)).toBe('Jon Sat and Heidi Sat move from Shared')
  })
})

describe('SavedCurveCard', () => {
  const renderCard = (template: SavedCurve, busy = false) => {
    const handlers = { onOpen: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn() }
    const s = render(<SavedCurveCard template={template} daysLabel="Mon–Fri" busy={busy} {...handlers} />)
    return { s, ...handlers }
  }

  it('shows an active curve with its days, notes and window, and opens on click', () => {
    const { s, onOpen } = renderCard(CURVE)
    const card = s.getByTestId('library-curve')
    expect(card.className).not.toContain('border-dashed')
    expect(s.getByText('Mon–Fri')).toBeTruthy()
    expect(s.getByText('Cooler first half.')).toBeTruthy()
    expect(s.getByText('11:15 PM → 7:00 AM · 79–84°')).toBeTruthy()
    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('switches and deletes without opening the curve', () => {
    const { s, onOpen, onToggle, onDelete } = renderCard(CURVE)
    const sw = s.getByRole('switch', { name: 'Turn off Weeknight' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(onToggle).toHaveBeenCalledWith(false)
    fireEvent.click(s.getByRole('button', { name: 'Delete Weeknight' }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('shows an inactive curve dashed with Off before its days and the maintain end', () => {
    const { s, onToggle } = renderCard({ ...CURVE, active: false, notes: '', endAction: 'maintain' })
    expect(s.getByTestId('library-curve').className).toContain('border-dashed')
    expect(s.getByText('Off · Mon–Fri')).toBeTruthy()
    expect(s.getByText(/Maintains final temperature$/)).toBeTruthy()
    expect(s.queryByText('Cooler first half.')).toBeNull()
    fireEvent.click(s.getByRole('switch', { name: 'Turn on Weeknight' }))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('disables the switch while a change is in flight', () => {
    const { s, onToggle } = renderCard(CURVE, true)
    const sw = s.getByRole('switch', { name: 'Turn off Weeknight' }) as HTMLButtonElement
    expect(sw.disabled).toBe(true)
    fireEvent.click(sw)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
