import { requiredTemplate } from './builderFixtures'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RuleEditor } from '../RuleEditor'
const mock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  automations: {
    nights: { useQuery: () => ({ data: [{ sleepRecordId: 1, label: 'Last night', date: 'Sep 28' }, { sleepRecordId: 2, label: 'Previous', date: 'Sep 27' }] }) },
    backtest: { useQuery: (input: unknown, opts: { placeholderData: (p: unknown) => unknown }) => {
      mock.query(input)
      return { data: opts.placeholderData({ ok: false, message: 'No samples' }) }
    } },
    backtestRange: { useQuery: (_input: unknown, opts: { placeholderData: (p: unknown) => unknown }) => ({ data: opts.placeholderData({ nights: 1, low: 1.25, peak: 300.2 }) }) },
  }, environment: { getLatestBedTemp: { useQuery: () => ({ data: { ambientTemp: 75 } }) } },
} }))
afterEach(() => vi.useRealTimers())
function choose(button: string, option: string) {
  fireEvent.click(screen.getAllByRole('button', { name: button })[0])
  fireEvent.click(screen.getAllByRole('button', { name: option }).slice(-1)[0])
}
it('edits triggers, conditions, expression and metadata, then saves only on request', () => {
  vi.useFakeTimers()
  const onSave = vi.fn(), onClose = vi.fn()
  render(<RuleEditor automation={requiredTemplate('restless')} onSave={onSave} onClose={onClose} />)
  expect(screen.getByTestId('threshold-range').textContent).toBe('last 1 night: 1.3–300')
  fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: 'Evening rule' } })
  fireEvent.click(screen.getByRole('tab', { name: 'R' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Active' }))
  fireEvent.click(screen.getByRole('button', { name: /Previous/ }))
  fireEvent.click(screen.getByRole('tab', { name: 'Time of day' }))
  choose('11pm', '10pm')
  choose('6am', '7am')
  fireEvent.click(screen.getByRole('button', { name: 'Time window' }))
  fireEvent.click(screen.getByRole('button', { name: 'Condition' }))
  choose('Current temp (level)', 'Ambient humidity')
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove condition' })[0])
  fireEvent.click(screen.getByRole('tab', { name: 'Expression' }))
  fireEvent.change(screen.getByLabelText('Temperature expression'), { target: { value: 'ambient - 2' } })
  expect(screen.getByText('73°F')).toBeTruthy()
  act(() => vi.advanceTimersByTime(350))
  expect(mock.query).toHaveBeenLastCalledWith(expect.objectContaining({ side: 'right', sleepRecordId: 2 }))
  expect(onSave).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Evening rule', side: 'right', mode: 'active', when: { type: 'time', between: ['22:00', '07:00'] }, then: [expect.objectContaining({ expr: 'ambient - 2' })] }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
}, 15_000)

it('switches action types and validates expression previews and numeric drafts', () => {
  const onSave = vi.fn()
  render(<RuleEditor automation={requiredTemplate('restless')} onSave={onSave} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('tab', { name: 'Threshold' }))
  fireEvent.click(screen.getByRole('tab', { name: 'On change' }))
  choose('Water low', 'Ambient light')
  fireEvent.click(screen.getByRole('tab', { name: 'Aggregate' }))
  choose('avg', 'max')
  fireEvent.click(screen.getByRole('tab', { name: 'Expression' }))
  for (const expr of ['invalid', 'target + 2', 'ambient', 'ambient + 3']) fireEvent.change(screen.getByLabelText('Temperature expression'), { target: { value: expr } })
  fireEvent.click(screen.getByRole('tab', { name: 'By amount' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Revert after' }))
  const input = screen.getAllByRole('textbox').filter(el => el.getAttribute('inputmode') === 'numeric')[0]
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.blur(input)
  fireEvent.click(screen.getAllByRole('button', { name: 'Increase' })[0])
  fireEvent.click(screen.getAllByRole('button', { name: 'Decrease' })[0])
  choose('Set temperature', 'Set power')
  choose('Set power', 'Notify')
  const message = screen.getByLabelText('Notification message')
  fireEvent.change(message, { target: { value: 'Bed ready' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ then: [expect.objectContaining({ action: 'notify', message: 'Bed ready' })] }))
}, 15_000)
