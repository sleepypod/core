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
  return <RemotePanel mapping={mapping} side={side} setSide={setSide} automations={[{ id: 42, name: 'Evening cooldown' }, { id: 43, name: 'Morning warmup' }]} />
}
describe('Remote mapping interactions', () => {
  it.each([
    ['temp.down', '1', '2'], ['temp.preset', '68', '71'], ['alarm.snooze', '540', '900'],
  ])('edits the %s parameter without parsing its display label', (action, initial, changed) => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Middle · single action' }), { target: { value: action } })
    const parameter = screen.getByRole('combobox', { name: 'Middle · single parameter' }) as HTMLSelectElement
    expect(parameter.value).toBe(initial)
    fireEvent.change(parameter, { target: { value: changed } })
    expect(parameter.value).toBe(changed)
    fireEvent.change(screen.getByRole('combobox', { name: 'Middle · single action' }), { target: { value: 'factory' } })
    expect(screen.queryByRole('combobox', { name: 'Middle · single parameter' })).toBeNull()
  })
  it('shows failed loads and failed saves, and permits explicit reload', () => {
    const reload = vi.fn()
    const base: MappingState = { config: undefined, loading: true, busy: false, error: undefined, save: vi.fn(), reload }
    const { rerender } = render(<RemotePanel mapping={base} side="left" setSide={vi.fn()} automations={[]} />)
    expect(screen.getByText('Loading remote mappings…')).toBeTruthy()
    rerender(<RemotePanel mapping={{ ...base, loading: false, error: 'Device unavailable' }} side="left" setSide={vi.fn()} automations={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reload).toHaveBeenCalledTimes(1)
    rerender(<RemotePanel mapping={{ ...base, config: emptyConfig(), error: 'Save failed' }} side="left" setSide={vi.fn()} automations={[]} />)
    expect(screen.getByRole('alert').textContent).toContain('Save failed')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(2)
  })
  it('materializes server-provided overrides and labels deleted automations', () => {
    const mapping: MappingState = { config: { ...emptyConfig(), left: { 'top.double': { action: 'automation.run', automationId: 99 } } }, loading: false, error: undefined, busy: false, save: vi.fn(), reload: vi.fn() }
    render(<RemotePanel mapping={mapping} side="left" setSide={vi.fn()} automations={[]} />)
    expect(screen.getByRole('combobox', { name: 'Top · double action' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Deleted automation' })).toBeTruthy()
  })
  it('can add all six optional inputs without creating overrides', () => {
    render(<Harness />)
    for (const name of ['Top · double', 'Middle · double', 'Bottom · double', 'Top + Middle', 'Middle + Bottom', 'Top + Bottom']) {
      fireEvent.click(screen.getByRole('button', { name: /Add another input/ }))
      fireEvent.click(screen.getByRole('button', { name }))
    }
    expect(screen.getAllByRole('combobox')).toHaveLength(9)
    expect(screen.getByText('Every supported input is in use.')).toBeTruthy()
    expect(screen.queryByText('1 remapped')).toBeNull()
  })
  it('cancels destructive changes and dismisses the menu when clicking outside', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy to right' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Replace mappings' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Add another input/ }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('button', { name: 'Top · double' })).toBeNull()
  })
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Top · double parameter' }), { target: { value: '43' } })
    expect((screen.getByRole('combobox', { name: 'Top · double parameter' }) as HTMLSelectElement).value).toBe('43')
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
    fireEvent.mouseLeave(option)
    expect(top.className).not.toContain('lit')
    fireEvent.focus(option)
    expect(top.className).toContain('lit')
    fireEvent.keyDown(option, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Top · double' })).toBeNull()
  })
})
