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
  expect(xhr.timeout).toBe(41 * 60_000)
  expect((screen.getByRole('button', { name: 'Upload and sync' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    xhr.onload?.()
  })
  await waitFor(() => expect(invalidate).toHaveBeenCalled())
  expect(screen.getByText(/Imported 12 new/)).toBeTruthy()
  expect(screen.getByText(/stage batches conflicted/)).toBeTruthy()
})

function startUpload(send = true) {
  const xhr = {
    open: vi.fn(), setRequestHeader: vi.fn(), send: vi.fn(), timeout: 0,
    upload: { onprogress: null as ((event: { lengthComputable: boolean, loaded: number, total: number }) => void) | null },
    status: 200, responseText: '{}',
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    ontimeout: null as (() => void) | null,
  }
  vi.stubGlobal('XMLHttpRequest', function XMLHttpRequest() {
    return xhr
  })
  render(<WatchUpload side="left" name="Sleeper" />)
  fireEvent.click(screen.getByRole('button', { name: 'Upload Apple Watch data' }))
  fireEvent.change(screen.getByLabelText('Import period'), { target: { value: '7' } })
  fireEvent.change(screen.getByLabelText('Health export'), { target: { files: [new File(['x'], 'export.zip')] } })
  if (send) fireEvent.click(screen.getByRole('button', { name: 'Upload and sync' }))
  return xhr
}

it('shows transfer progress, protects an active import, and allows closing after success', async () => {
  const xhr = startUpload()
  expect(xhr.open).toHaveBeenCalledWith('POST', '/api/biometrics/watch-upload?side=left&days=7')
  act(() => xhr.upload.onprogress?.({ lengthComputable: false, loaded: 5, total: 10 }))
  expect(screen.getByRole('status').textContent).toContain('0%')
  act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 }))
  expect(screen.getByRole('status').textContent).toContain('50%')
  act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 }))
  expect(screen.getByRole('status').textContent).toContain('Importing on the pod')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  xhr.responseText = JSON.stringify({ vitals: 0, stages: 2, matchedVitals: 0, matchedStages: 2, rejectedStageBatches: 0 })
  await act(async () => xhr.onload?.())
  expect(screen.getByRole('status').textContent).toContain('2 new sleep-stage segments')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([
  ['server rejection', 413, '{"error":"Upload exceeds 512 MiB"}', 'load', 'Upload exceeds 512 MiB'],
  ['empty error response', 500, '{}', 'load', 'Upload failed'],
  ['malformed response', 502, '<html>error</html>', 'load', 'invalid response'],
  ['disconnect', 0, '', 'error', 'Connection lost'],
  ['timeout', 0, '', 'timeout', 'Import timed out'],
])('reports %s and allows selecting a new file for retry', async (_, status, body, event, message) => {
  const xhr = startUpload()
  xhr.status = status
  xhr.responseText = body
  await act(async () => {
    if (event === 'load') xhr.onload?.()
    else if (event === 'error') xhr.onerror?.()
    else xhr.ontimeout?.()
  })
  expect(screen.getByRole('alert').textContent).toContain(message)
  expect((screen.getByRole('button', { name: 'Upload and sync' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.change(screen.getByLabelText('Health export'), { target: { files: [] } })
  expect(screen.queryByRole('alert')).toBeNull()
  expect((screen.getByRole('button', { name: 'Upload and sync' }) as HTMLButtonElement).disabled).toBe(true)
})

it('rejects an oversized file before sending it', () => {
  const xhr = startUpload(false)
  const file = new File(['x'], 'export.zip')
  Object.defineProperty(file, 'size', { value: 513 * 1024 * 1024 })
  fireEvent.change(screen.getByLabelText('Health export'), { target: { files: [file] } })
  xhr.send.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Upload and sync' }))
  expect(screen.getByRole('alert').textContent).toContain('smaller than 512 MiB')
  expect(xhr.send).not.toHaveBeenCalled()
})

it('shows a placeholder until a file is chosen', () => {
  render(<WatchUpload side="left" name="Sleeper" />)
  fireEvent.click(screen.getByRole('button', { name: 'Upload Apple Watch data' }))
  expect(screen.getByText('No file selected')).toBeTruthy()
})

it('opens the hidden file picker from a styled button and names the selected file', () => {
  const xhr = startUpload(false)
  const input = screen.getByLabelText('Health export') as HTMLInputElement
  const choose = screen.getByRole('button', { name: 'Choose file' }) as HTMLButtonElement
  expect(input.className).toContain('sr-only')
  expect(input.tabIndex).toBe(-1)
  const click = vi.spyOn(input, 'click').mockImplementation(() => {})
  fireEvent.click(choose)
  expect(click).toHaveBeenCalledOnce()
  const description = choose.getAttribute('aria-describedby')
  expect(description && document.getElementById(description)?.textContent).toBe('export.zip')
  fireEvent.click(screen.getByRole('button', { name: 'Upload and sync' }))
  expect(xhr.send).toHaveBeenCalled()
  expect(choose.disabled).toBe(true)
  fireEvent.click(choose)
  expect(click).toHaveBeenCalledOnce()
})
