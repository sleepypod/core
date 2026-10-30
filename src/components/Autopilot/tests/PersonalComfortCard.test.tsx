import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PersonalComfortDetails } from '../PersonalComfortCard'
import { missingComfortSignals } from '@/src/comfort/signals'
import { defaultComfortState } from '@/src/comfort/policy'
import type { ComfortStatus } from '@/src/comfort/contract'

function status(): ComfortStatus {
  return {
    apiVersion: 1, side: 'left', generatedAt: 1792922400000, timezone: 'America/Los_Angeles', deviceDate: '2026-10-25',
    state: defaultComfortState(), evaluatedAt: null, decision: null, fault: null, history: [], runtime: 'running',
    activation: { available: false, reason: 'Hardware qualification and reviewed Preview nights are pending.' },
    features: { sensorAware: false, followBedtime: false },
  }
}

describe('personal comfort controls', () => {
  it('requires sensor consent, preserves bedtime consent across Preview and clears it when disabling sensors', () => {
    const data = status()
    data.features = { sensorAware: true, followBedtime: true }
    const configure = vi.fn()
    const view = render(<PersonalComfortDetails data={data} pending={false} onConfigure={configure} onFeedback={vi.fn()} />)
    expect((screen.getByRole('checkbox', { name: /Follow earlier/ }) as HTMLInputElement).disabled).toBe(true)
    if (!data.state) throw new Error('Fixture requires state')
    data.state.config = { ...data.state.config, sensorAware: true, followBedtime: true }
    view.rerender(<PersonalComfortDetails data={data} pending={false} onConfigure={configure} onFeedback={vi.fn()} />)
    expect(screen.getByLabelText('Bed-entry timing observation').textContent).toContain('Waiting for a current bed-entry evaluation')
    fireEvent.click(screen.getByRole('button', { name: 'Start Preview' }))
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'preview', followBedtime: true }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Use Pod sensor guard/ }))
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ sensorAware: false, followBedtime: false }))
  })

  it('keeps sensor consent through starting Preview and shows actual baseline coverage', () => {
    const data = status()
    data.features.sensorAware = true
    if (!data.state) throw new Error('Fixture requires state')
    data.state.config.sensorAware = true
    data.signals = { ...missingComfortSignals(), state: 'learning', reason: 'Needs more qualified days.', baselineDays: 3 }
    const configure = vi.fn()
    render(<PersonalComfortDetails data={data} pending={false} onConfigure={configure} onFeedback={vi.fn()} />)
    expect(screen.getByText('3 / 7 minimum')).toBeTruthy()
    expect(screen.getByText('Building your baseline')).toBeTruthy()
    expect(screen.getByText('Incomplete')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start Preview' }))
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'preview', sensorAware: true }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Use Pod sensor guard/ }))
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'off', sensorAware: false }))
  })

  it('offers only explicit Preview, keeps an empty report honest and submits feedback in the Pod timezone', () => {
    const configure = vi.fn()
    const feedback = vi.fn()
    render(<PersonalComfortDetails data={status()} pending={false} onConfigure={configure} onFeedback={feedback} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start Preview' }))
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ mode: 'preview', minimumF: 70, maximumF: 95 }))
    expect(screen.getByText('No evaluation recorded yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull()
    fireEvent.change(screen.getByLabelText('How did the bed feel?'), { target: { value: 'warm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save check-in' }))
    expect(feedback).toHaveBeenCalledWith({ date: '2026-10-25', comfort: 'warm' })
  })

  it('labels proposal versus hardware, persists the range and displays a manual pause', () => {
    const data = status()
    if (!data.state) throw new Error('Fixture needs state')
    data.state.config.mode = 'preview'
    data.state.pausedUntil = data.generatedAt + 3_600_000
    data.decision = { eligible: true, baselineF: 75, proposedF: 74, reason: 'Preview only.', retainPreviousLease: false, pauseRequired: false }
    const configure = vi.fn()
    render(<PersonalComfortDetails data={data} pending={false} onConfigure={configure} onFeedback={vi.fn()} />)
    expect(screen.getByText(/This is a proposal, not a hardware action/)).toBeTruthy()
    expect(screen.getByText(/Manual pause until/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Maximum °F'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save range' }))
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ maximumF: 90, mode: 'preview' }))
  })

  it('disables configuration when storage is unavailable and reports stopped evaluation', () => {
    const data = { ...status(), fault: 'Journal unavailable', runtime: 'stopped' as const }
    render(<PersonalComfortDetails data={data} pending={false} onConfigure={vi.fn()} onFeedback={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Start Preview' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('The Preview service is stopped.')).toBeTruthy()
  })
})
