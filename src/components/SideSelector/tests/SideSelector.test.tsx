import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  selectSide: vi.fn(),
  toggleLink: vi.fn(),
  selectedSide: 'left' as 'left' | 'right' | 'both',
  isLinked: false,
  status: undefined as unknown,
}))

vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({ selectedSide: m.selectedSide, isLinked: m.isLinked, selectSide: m.selectSide, toggleLink: m.toggleLink }),
}))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Jon', rightName: 'Heidi' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
vi.mock('@/src/hooks/useDeviceStatus', () => ({ useDeviceStatus: () => ({ status: m.status }) }))

import { SideSelector } from '../SideSelector'

const side = (target: number, level: number) => ({ currentTemperature: 80, targetTemperature: target, targetLevel: level })

beforeEach(() => {
  m.selectSide.mockReset()
  m.toggleLink.mockReset()
  m.selectedSide = 'left'
  m.isLinked = false
  m.status = { leftSide: side(76, 5), rightSide: side(82, 0) }
})
afterEach(cleanup)

describe('SideSelector', () => {
  it('shows offset · target for an on side and Off for an off side', () => {
    const screen = render(<SideSelector />)
    expect(screen.getByText('−4 · 76°')).toBeTruthy()
    expect(screen.getByText('Off')).toBeTruthy()
  })

  it('prefers optimistic overrides over the status stream', () => {
    const screen = render(<SideSelector overrides={{ left: { targetF: 70, isOn: true }, right: { targetF: 85, isOn: true } }} />)
    expect(screen.getByText('−10 · 70°')).toBeTruthy()
    expect(screen.getByText('+5 · 85°')).toBeTruthy()
  })

  it('marks the selected side and selects the other on tap', () => {
    const screen = render(<SideSelector />)
    const jon = screen.getByRole('button', { name: /Jon/ })
    const heidi = screen.getByRole('button', { name: /Heidi/ })
    expect(jon.getAttribute('aria-pressed')).toBe('true')
    expect(heidi.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(heidi)
    expect(m.selectSide).toHaveBeenCalledExactlyOnceWith('right')
  })

  it('highlights both sides when linked and toggles link from the middle button', () => {
    m.selectedSide = 'both'
    m.isLinked = true
    const screen = render(<SideSelector />)
    expect(screen.getByRole('button', { name: /Jon/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Heidi/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Unlink sides' }))
    expect(m.toggleLink).toHaveBeenCalledOnce()
  })

  it('shows a placeholder until status arrives', () => {
    m.status = undefined
    const screen = render(<SideSelector />)
    expect(screen.getAllByText('—')).toHaveLength(2)
  })
})
