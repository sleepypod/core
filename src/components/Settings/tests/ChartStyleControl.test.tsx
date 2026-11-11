import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/src/components/Base/loadThree', () => ({ hasWebGL: () => true, loadThree: vi.fn() }))
const { ChartStyleControl } = await import('../AppearanceSettings')

beforeEach(() => localStorage.clear())

it('switches charts between flat and 3D on this device', () => {
  render(<ChartStyleControl />)
  const group = screen.getByRole('tablist', { name: 'Chart style' })
  expect(group).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Flat' }))
  expect(localStorage.getItem('sleepypod.base.charts.style')).toBe('flat')
  fireEvent.click(screen.getByRole('tab', { name: '3D' }))
  expect(localStorage.getItem('sleepypod.base.charts.style')).toBe('3d')
})
