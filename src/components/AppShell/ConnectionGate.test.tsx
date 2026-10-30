import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConnectionGate } from './ConnectionGate'

const fetchMock = vi.fn<typeof fetch>()
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_DEMO', '')
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('BroadcastChannel', undefined)
  fetchMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('unmounts owner views on an account change and ignores an older in-flight refresh', async () => {
  fetchMock.mockResolvedValueOnce(response({ configured: true, authenticated: true }))
  render(<ConnectionGate><div data-testid="private-owner">Owner history</div></ConnectionGate>)
  await screen.findByTestId('private-owner')
  let finishRefresh: (value: Response) => void = () => {}
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
    finishRefresh = resolve
  }))
  fireEvent(window, new Event('focus'))
  fireEvent(window, new StorageEvent('storage', { key: 'sleepypod-account-change', newValue: 'changed' }))
  expect(screen.queryByTestId('private-owner')).toBeNull()
  await act(async () => {
    finishRefresh(response({ configured: true, authenticated: true }))
  })
  expect(screen.queryByTestId('private-owner')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('personal account')
})

it('does not mount owner data when an account switch happens during owner login', async () => {
  fetchMock.mockResolvedValueOnce(response({ configured: true, authenticated: false }))
  render(<ConnectionGate><div data-testid="private-owner">Owner history</div></ConnectionGate>)
  await screen.findByLabelText('Connection key')
  fetchMock.mockResolvedValueOnce(response({ browserScopeRevision: 'current-browser-revision' }))
  let finishLogin: (value: Response) => void = () => {}
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
    finishLogin = resolve
  }))
  fireEvent.change(screen.getByLabelText('Connection key'), { target: { value: 'example-owner-key-that-is-long-enough' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect to your Pod' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
  fireEvent(window, new StorageEvent('storage', { key: 'sleepypod-account-change', newValue: 'changed' }))
  await act(async () => {
    finishLogin(response({ authenticated: true }))
  })
  expect(screen.queryByTestId('private-owner')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('account changed')
})

it('offers personal connection instead of an owner-key login after shared activation', async () => {
  fetchMock.mockResolvedValueOnce(response({ configured: true, authenticated: false, personalConnectionRequired: true }))
  render(<ConnectionGate><div data-testid="private-owner">Owner history</div></ConnectionGate>)
  expect((await screen.findByRole('link', { name: 'Open my personal workspace' })).getAttribute('href')).toBe('/household/index.html')
  expect(screen.queryByLabelText('Connection key')).toBeNull()
  expect(screen.queryByTestId('private-owner')).toBeNull()
})

it('does not mount cached owner data when privacy storage is unavailable', async () => {
  fetchMock.mockResolvedValueOnce(response({ configured: true, authenticated: true, privacyAvailable: false }))
  render(<ConnectionGate><div data-testid="private-owner">Owner history</div></ConnectionGate>)
  await screen.findByRole('alert')
  expect(screen.queryByTestId('private-owner')).toBeNull()
})
