import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordingHealthSummary } from '../RecordingHealthCard'
import type { RecordingHealth } from '@/src/recording-health/contract'

const now = Date.UTC(2026, 10, 10)
const ready: RecordingHealth = { apiVersion: 1, generatedAt: now, expiresAt: now + 60_000, state: 'ready', summary: 'Recording checks are ready',
  checks: [{ id: 'sensor', title: 'Presence sensor', state: 'ok', detail: 'Frames arriving', observedAt: now, nextStep: null }], historicalWindowHours: 24 }
afterEach(cleanup)

function show(data: RecordingHealth | undefined = ready, unavailable = false, clock = now) {
  const retry = vi.fn()
  render(<RecordingHealthSummary data={data} unavailable={unavailable} now={clock} diagnosticsHref="/en/system?section=health" onRetry={retry} pending={false} />)
  return retry
}

describe('recording health card', () => {
  it('shows a current result, explicit scope, retry and diagnostics', () => {
    const retry = show()
    expect(screen.getByText('Recording checks are ready')).toBeTruthy()
    expect(screen.getByText(/not sleep quality or Watch imports/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(screen.getByRole('link', { name: 'Open recording diagnostics' }).getAttribute('href')).toBe('/en/system?section=health')
  })

  it.each([true, false])('does not present an old successful response as current after failure or expiry (%s)', (unavailable) => {
    show(ready, unavailable, unavailable ? now : now + 60_001)
    expect(screen.queryByText('Recording checks are ready')).toBeNull()
    expect(screen.getByText('Recording check unavailable')).toBeTruthy()
    expect(screen.getByText('See last successful check')).toBeTruthy()
  })

  it('expands actionable failures without adding repair or hardware buttons', () => {
    show({ ...ready, state: 'attention', summary: 'Recording needs attention', checks: [
      { ...ready.checks[0], state: 'attention', detail: 'No presence frames', nextStep: 'Check the cover connection' },
    ] })
    expect(screen.getByText('See recording checks').parentElement?.hasAttribute('open')).toBe(true)
    expect(screen.getByText('Check the cover connection')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('withholds ready for a future result', () => {
    show({ ...ready, generatedAt: now + 1000 })
    expect(screen.queryByText('Recording checks are ready')).toBeNull()
  })

  it('expires at the earliest underlying observation even when the report was just fetched', () => {
    show({ ...ready, expiresAt: now })
    expect(screen.queryByText('Recording checks are ready')).toBeNull()
  })
})
