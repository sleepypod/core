import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WatchUpload } from '../WatchUpload'

const invalidate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/src/utils/trpc', () => ({ trpc: { useUtils: () => ({ biometrics: { invalidate } }) } }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('uploads for the named sleeper, reports partial conflicts, and refreshes charts', async () => {
  const xhr = {
    open: vi.fn(), setRequestHeader: vi.fn(), send: vi.fn(), upload: {}, timeout: 0,
    status: 200, responseText: JSON.stringify({ vitals: 12, stages: 0, matchedVitals: 14, matchedStages: 3, rejectedStageBatches: 1 }),
    onload: null as (() => void) | null,
  }
  vi.stubGlobal('XMLHttpRequest', function XMLHttpRequest() {
    return xhr
  })
  render(<WatchUpload side="right" name="Test sleeper" />)
  fireEvent.click(screen.getByRole('button', { name: 'Upload Apple Watch data' }))
  expect(screen.getByText('Test sleeper')).toBeTruthy()
  const file = new File(['<HealthData/>'], 'export.xml', { type: 'application/xml' })
  fireEvent.change(screen.getByLabelText('Health export'), { target: { files: [file] } })
  fireEvent.click(screen.getByRole('button', { name: 'Upload and sync' }))
  expect(xhr.open).toHaveBeenCalledWith('POST', '/api/biometrics/watch-upload?side=right&days=30')
  expect(xhr.send).toHaveBeenCalledWith(file)
  expect((screen.getByRole('button', { name: 'Upload and sync' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    xhr.onload?.()
  })
  await waitFor(() => expect(invalidate).toHaveBeenCalled())
  expect(screen.getByText(/Imported 12 new/)).toBeTruthy()
  expect(screen.getByText(/stage batches conflicted/)).toBeTruthy()
})
