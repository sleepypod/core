import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BedSetupSettings } from '../BedSetupSettings'

const m = vi.hoisted(() => ({ mutate: vi.fn(), invalidate: vi.fn(), error: null as Error | null }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ settings: { getAll: { invalidate: m.invalidate } } }),
  settings: { updateDevice: { useMutation: () => ({ mutate: m.mutate, isPending: false, error: m.error }) } },
} }))
beforeEach(() => {
  m.mutate.mockClear()
  m.error = null
})

it('changes permanent setup without writing away or linking preferences', () => {
  render(<BedSetupSettings device={{ bedMode: 'two', unusedZoneMode: 'off' }} names={{ left: 'Alex', right: 'Sam' }} />)
  fireEvent.change(screen.getByLabelText('Bed setup'), { target: { value: 'solo-right' } })
  expect(m.mutate).toHaveBeenCalledExactlyOnceWith({ bedMode: 'solo-right' })
})

it.each(['follow', 'off', 'independent'])('saves the %s temperature policy separately', (unusedZoneMode) => {
  render(<BedSetupSettings device={{ bedMode: 'solo-left', unusedZoneMode: 'off' }} names={{ left: 'Alex', right: 'Sam' }} />)
  fireEvent.change(screen.getByLabelText('Other temperature zone'), { target: { value: unusedZoneMode } })
  expect(m.mutate).toHaveBeenCalledExactlyOnceWith({ unusedZoneMode })
})

it('shows a save failure', () => {
  m.error = new Error('Unable to save bed setup')
  render(<BedSetupSettings device={{}} names={{ left: 'Alex', right: 'Sam' }} />)
  expect(screen.getByText('Unable to save bed setup')).toBeTruthy()
})
