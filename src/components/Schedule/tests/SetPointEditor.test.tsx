import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SetPointEditor } from '../SetPointEditor'
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
it('creates a point, saves only changed fields and confirms deletion', () => {
  const props = { open: true, onClose: vi.fn(), onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn() }
  const { rerender } = render(<SetPointEditor {...props} editingPoint={null} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add set point' }))
  expect(props.onCreate).toHaveBeenCalledWith('22:00', 78)
  const point = { id: 2, time: '22:00', temperature: 78 }
  rerender(<SetPointEditor {...props} editingPoint={point} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(props.onUpdate).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '23:00' } })
  fireEvent.change(screen.getByRole('slider'), { target: { value: '80' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(props.onUpdate).toHaveBeenCalledWith(2, { time: '23:00', temperature: 80 })
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(props.onDelete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
  expect(props.onDelete).toHaveBeenCalledWith(2)
})
