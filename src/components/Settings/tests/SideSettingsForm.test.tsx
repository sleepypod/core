/**
 * SideSettingsForm — always-on / auto-off mutual exclusion, the presence
 * gate on enabling auto-off, and name commit-on-blur.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const mutate = vi.fn()
  return {
    mutate,
    trpc: {
      useUtils: () => ({ settings: { getAll: { invalidate: vi.fn() } } }),
      settings: {
        updateSide: { useMutation: () => ({ mutate, isPending: false, error: null }) },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { SideSettingsForm } from '../SideSettingsForm'

const base = {
  side: 'left' as const,
  name: 'Jon',
  awayMode: false,
  alwaysOn: false,
  autoOffEnabled: false,
  autoOffMinutes: 30,
}

beforeEach(() => trpcMock.mutate.mockClear())

describe('SideSettingsForm', () => {
  it('turning Always on off-switches auto-off in the same mutation', () => {
    render(<SideSettingsForm side="left" sideData={{ ...base, autoOffEnabled: true }} presenceAvailable />)
    fireEvent.click(screen.getByLabelText('Toggle always on for Left side'))
    expect(trpcMock.mutate).toHaveBeenCalledWith({ side: 'left', alwaysOn: true, autoOffEnabled: false })
    expect(screen.getByLabelText('Toggle auto-off for Left side').getAttribute('aria-checked')).toBe('false')
  })

  it('turning auto-off on clears Always on', () => {
    render(<SideSettingsForm side="left" sideData={{ ...base, alwaysOn: true }} presenceAvailable />)
    fireEvent.click(screen.getByLabelText('Toggle auto-off for Left side'))
    expect(trpcMock.mutate).toHaveBeenCalledWith({ side: 'left', autoOffEnabled: true, alwaysOn: false })
  })

  it('blocks enabling auto-off when presence cannot be sensed', () => {
    render(<SideSettingsForm side="left" sideData={base} presenceAvailable={false} />)
    const toggle = screen.getByLabelText('Toggle auto-off for Left side') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/Requires presence sensing/)).toBeTruthy()
    expect(screen.getByText('Presence unavailable')).toBeTruthy()
  })

  it('still allows turning auto-off off when presence is unavailable', () => {
    render(<SideSettingsForm side="left" sideData={{ ...base, autoOffEnabled: true }} presenceAvailable={false} />)
    const toggle = screen.getByLabelText('Toggle auto-off for Left side') as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    expect(screen.getByText(/auto-off is currently inactive/)).toBeTruthy()
    fireEvent.click(toggle)
    expect(trpcMock.mutate).toHaveBeenCalledWith({ side: 'left', autoOffEnabled: false })
  })

  it('treats loading presence (null) as available', () => {
    render(<SideSettingsForm side="left" sideData={base} presenceAvailable={null} />)
    expect((screen.getByLabelText('Toggle auto-off for Left side') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('Checking presence')).toBeTruthy()
  })

  it('saves the auto-off duration from the select', () => {
    render(<SideSettingsForm side="left" sideData={{ ...base, autoOffEnabled: true }} presenceAvailable />)
    fireEvent.change(screen.getByLabelText('Auto-off after'), { target: { value: '90' } })
    expect(trpcMock.mutate).toHaveBeenCalledWith({ side: 'left', autoOffMinutes: 90 })
  })

  it('commits a trimmed name on blur and reverts a blank one', () => {
    render(<SideSettingsForm side="left" sideData={base} presenceAvailable />)
    const input = screen.getByDisplayValue('Jon')
    fireEvent.change(input, { target: { value: '  Jonathan ' } })
    fireEvent.blur(input)
    expect(trpcMock.mutate).toHaveBeenCalledWith({ side: 'left', name: 'Jonathan' })

    trpcMock.mutate.mockClear()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(trpcMock.mutate).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('Jon')
  })

  it('toggles away mode', () => {
    render(<SideSettingsForm side="left" sideData={base} presenceAvailable />)
    fireEvent.click(screen.getByLabelText('Toggle away mode for Left side'))
    expect(trpcMock.mutate).toHaveBeenCalledWith({ side: 'left', awayMode: true })
  })
})
