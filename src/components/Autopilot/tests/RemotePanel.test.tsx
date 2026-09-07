import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editConfig, emptyConfig, type RemoteConfig, type Side } from '@/src/remote/model'
import { RemotePanel, type MappingState } from '../RemotePanel'

afterEach(cleanup)
function Harness({ initial = emptyConfig() }: { initial?: RemoteConfig }) {
  const [config, setConfig] = useState(initial)
  const [side, setSide] = useState<Side>('left')
  const mapping: MappingState = {
    config, loading: false, error: undefined, busy: false,
    save: (target, edit) => setConfig(current => editConfig(current, target, edit)),
    reload: vi.fn(),
  }
  return <RemotePanel mapping={mapping} side={side} setSide={setSide} automations={[{ id: 42, name: 'Evening cooldown' }]} />
}
describe('Remote mapping interactions', () => {
  it('shows three permanent inputs and disables unsupported hardware actions', () => {
    render(<Harness />)
    expect(screen.getAllByRole('combobox')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'Remove Top · single' })).toBeNull()
    const select = screen.getByRole('combobox', { name: 'Top · single action' }) as HTMLSelectElement
    expect(select.value).toBe('factory')
    expect((within(select).getByRole('option', { name: 'Go to elevation preset (unavailable)' }) as HTMLOptionElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reset this remote' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('updates structured parameters, tracks side-specific overrides, and resets each row', () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Top · single action' }), { target: { value: 'temp.up' } })
    expect(screen.getByText('1 remapped')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Top · single parameter' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Right remote' }))
    expect((screen.getByRole('combobox', { name: 'Top · single action' }) as HTMLSelectElement).value).toBe('factory')
    expect(screen.queryByText('1 remapped')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Left remote' }))
    expect((screen.getByRole('combobox', { name: 'Top · single parameter' }) as HTMLSelectElement).value).toBe('3')
    fireEvent.click(screen.getByRole('button', { name: 'Reset Top · single' }))
    expect(screen.queryByRole('combobox', { name: 'Top · single parameter' })).toBeNull()
    expect(screen.queryByText('1 remapped')).toBeNull()
  })
  it('adds an input without an override, confirms copy, and removes extras independently', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Add another input 6 available' }))
    fireEvent.click(screen.getByRole('button', { name: 'Top · double' }))
    expect(screen.queryByText('1 remapped')).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Top · double action' }), { target: { value: 'automation.run' } })
    expect((screen.getByRole('combobox', { name: 'Top · double parameter' }) as HTMLSelectElement).value).toBe('42')
    fireEvent.click(screen.getByRole('button', { name: 'Copy to right' }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace mappings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Right remote' }))
    expect((screen.getByRole('combobox', { name: 'Top · double action' }) as HTMLSelectElement).value).toBe('automation.run')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Top · double' }))
    expect(screen.queryByRole('combobox', { name: 'Top · double action' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Left remote' }))
    expect(screen.getByRole('combobox', { name: 'Top · double action' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset this remote' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset remote' }))
    expect(screen.queryByRole('combobox', { name: 'Top · double action' })).toBeNull()
  })
  it('links segment selection and hover with rows and closes the input menu on Escape', () => {
    render(<Harness />)
    const top = screen.getByRole('button', { name: 'Select top button' })
    fireEvent.click(top)
    expect(top.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(top)
    expect(top.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Add another input 6 available' }))
    const option = screen.getByRole('button', { name: 'Top · double' })
    fireEvent.mouseEnter(option)
    expect(top.className).toContain('lit')
    fireEvent.keyDown(option, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Top · double' })).toBeNull()
  })
})
