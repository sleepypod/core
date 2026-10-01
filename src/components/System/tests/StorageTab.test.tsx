import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const GB = 1024 ** 3

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(),
  result: undefined as unknown,
  pending: false,
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ system: { getStorage: { invalidate: vi.fn() } } }),
    system: {
      getStorage: { useQuery: () => ({ data: mocks.pending ? undefined : mocks.data, isPending: mocks.pending, isLoading: false, error: null }) },
      freeStorage: { useMutation: () => ({ mutate: mocks.mutate, isPending: false, error: null, data: mocks.result }) },
    },
  },
}))

import { StorageTab } from '../StorageTab'

beforeEach(() => {
  mocks.mutate.mockReset()
  mocks.result = undefined
  mocks.pending = false
  mocks.data = {
    persistent: { totalBytes: 15 * GB, usedBytes: 12 * GB, availableBytes: 3 * GB, usedPercent: 80 },
    prunerTargetPercent: 80,
    segments: [
      { key: 'rawArchive', bytes: 3.4 * GB },
      { key: 'app', bytes: 0.7 * GB },
      { key: 'database', bytes: 0.07 * GB },
      { key: 'swap', bytes: 1.1 * GB },
      { key: 'reclaimable', bytes: 6 * GB },
      { key: 'other', bytes: 0.73 * GB },
    ],
    rawHistory: { fileCount: 1322, oldest: '2026-09-14T00:00:00Z', newest: '2026-09-28T00:00:00Z', days: 14 },
    reclaimable: {
      available: true,
      totalBytes: 6.04 * GB,
      items: [
        { path: '/persistent/sleepypod-releases/old', bytes: 5 * GB, reason: 'old release build', kind: 'release' },
        { path: '/persistent/sleepypod-rollback.abc', bytes: 1 * GB, reason: 'leftover rollback copy', kind: 'temp' },
        { path: '/persistent/sleepypod-data/biometrics.db.bak.1', bytes: 0.04 * GB, reason: 'old biometrics.db backup', kind: 'backup' },
      ],
    },
  }
})

describe('StorageTab', () => {
  it('shows a skeleton while the first fetch is pending instead of the error card', () => {
    mocks.pending = true
    render(<StorageTab />)
    expect(screen.getByTestId('storage-skeleton')).toBeTruthy()
    expect(screen.queryByText('Storage info unavailable')).toBeNull()
  })

  it('shows usage, the legend and days of raw history', () => {
    render(<StorageTab />)
    expect(screen.getByText('12.0 GB of 15.0 GB used · 3.0 GB free')).toBeTruthy()
    expect(screen.getByText('Raw sensor archive')).toBeTruthy()
    expect(screen.getByText('14 days')).toBeTruthy()
    expect(screen.getByTestId('seg-reclaimable')).toBeTruthy()
  })

  it('lists leftovers without database backups until they are included', () => {
    render(<StorageTab />)
    expect(screen.getByText('sleepypod-releases/old')).toBeTruthy()
    expect(screen.queryByText('sleepypod-data/biometrics.db.bak.1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Free up 6.0 GB' })).toBeTruthy()

    fireEvent.click(screen.getByRole('switch', { name: 'Include old database backups' }))
    expect(screen.getByText('sleepypod-data/biometrics.db.bak.1')).toBeTruthy()
  })

  it('asks before deleting, then runs the cleanup', () => {
    render(<StorageTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Free up 6.0 GB' }))
    expect(mocks.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(mocks.mutate).toHaveBeenCalledWith({ includeDbBackups: false })
  })

  it('reports what was freed', () => {
    mocks.result = { freedBytes: 6 * GB, removed: 2 }
    render(<StorageTab />)
    expect(screen.getByRole('status').textContent).toBe('Freed 6.0 GB from 2 items.')
  })

  it('explains when the cleanup tool is missing', () => {
    mocks.data = { ...(mocks.data as object), reclaimable: { available: false, items: [], totalBytes: 0 } }
    render(<StorageTab />)
    expect(screen.getByText(/Cleanup tool not installed/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Free up/ })).toBeNull()
  })
})
