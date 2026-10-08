import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TempStepper } from '../TempStepper'
import type { SideNightPhases } from '../useNightPhases'

const mock = vi.hoisted(() => ({ timeFormat: '12h' as '12h' | '24h' }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => mock.timeFormat }))

const schedule = {
  phases: {
    day: 'monday',
    days: ['monday'],
    night: { temperatureF: 74, start: '22:00', end: '06:00', minutes: 480, times: ['22:00'] },
    dawn: { temperatureF: 84, start: '06:00', end: '06:30', minutes: 30, times: ['06:00'] },
  },
  draft: true,
  isLoading: false,
  error: null,
  saving: false,
  valueF: (p: 'night' | 'dawn') => (p === 'night' ? 74 : 84),
  nudge: vi.fn(),
} as unknown as SideNightPhases

const stepper = <TempStepper tab="night" onTabChange={vi.fn()} unit="F" display="degrees" targetF={76} bedF={78} isOn nowDisabled={false} onStepNow={vi.fn()} schedule={schedule} onStepPhase={vi.fn()} />

afterEach(() => {
  cleanup()
  mock.timeFormat = '12h'
})

it.each([
  ['12h', '10:00 PM – 6:00 AM', '(10:00 PM – 7:00 AM)'],
  ['24h', '22:00 – 06:00', '(22:00 – 07:00)'],
] as const)('shows the phase window and template curve in the %s clock', async (format, caption, template) => {
  mock.timeFormat = format
  render(stepper)
  expect(screen.getByText(caption)).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'About suggested temperatures' })))
  expect(screen.getByText(new RegExp(template.replace(/[()]/g, '\\$&')))).toBeTruthy()
})
