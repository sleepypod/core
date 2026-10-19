import { flashInsights } from '@/src/lib/flashInsights'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const GB = 1024 ** 3

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(),
  result: undefined as unknown,
  pending: false,
  flash: null as unknown,
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ system: { getStorage: { invalidate: vi.fn() } } }),
    system: {
      getStorage: { useQuery: () => ({ data: mocks.pending ? undefined : mocks.data, isPending: mocks.pending, isLoading: false, error: null }) },
      getFlashHealth: { useQuery: () => ({ data: mocks.flash }) },
      freeStorage: { useMutation: () => ({ mutate: mocks.mutate, isPending: false, error: null, data: mocks.result }) },
    },
  },
}))

vi.mock('../DataRecordingCard', () => ({ DataRecordingCard: () => <div>Data recording</div> }))

import { StorageTab } from '../StorageTab'

beforeEach(() => {
  mocks.mutate.mockReset()
  mocks.result = undefined
  mocks.pending = false
  mocks.flash = null
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

  describe('flash endurance', () => {
    const flash = (over: Record<string, unknown> = {}) => ({
      insights: flashInsights([
        { at: 0, bootId: 'a', sectorsWritten: 0 },
        { at: 3_600_000, bootId: 'a', sectorsWritten: 100_000 },
      ], 3_600_000),
      device: 'mmcblk0',
      name: 'C9A551',
      capacityBytes: 29 * GB,
      lifeTime: [{ minPercent: 30, maxPercent: 40 }, null],
      preEol: 'normal',
      sinceBoot: { bytes: 1.5 * GB, uptimeSeconds: 2600 },
      perDay: { bytes: 3.1 * GB, coveredHours: 168 },
      ...over,
    })

    it('is hidden off-pod', () => {
      render(<StorageTab />)
      expect(screen.queryByTestId('flash-card')).toBeNull()
    })

    it('shows wear, reserve blocks and writes per day', () => {
      mocks.flash = flash()
      render(<StorageTab />)
      expect(screen.getByText('C9A551 · 29.0 GB eMMC')).toBeTruthy()
      expect(screen.getByText('30–40%')).toBeTruthy()
      expect(screen.queryByText('Wear (main area)')).toBeNull()
      expect(screen.getAllByText('1.23 GB/day')).toHaveLength(3)
      expect(screen.getByText('Last 24 hours')).toBeTruthy()
      expect(screen.getByRole('group', { name: 'Hourly flash write rates' })).toBeTruthy()
      expect(screen.getByText(/Keeping transient data in RAM/)).toBeTruthy()
      expect(document.querySelector('details')).toBeNull()
      expect(screen.getAllByText('Normal').length).toBeGreaterThan(0)
    })

    it('says it is still measuring before an hour of samples', () => {
      mocks.flash = flash({ perDay: null, insights: flashInsights([], 0) })
      render(<StorageTab />)
      expect(screen.getAllByText('Measuring…')).toHaveLength(3)
      expect(screen.getByText(/missing data is not zero writes/)).toBeTruthy()
    })

    it('lets keyboard and pointer users inspect an interval without treating missing data as zero', () => {
      mocks.flash = flash()
      render(<StorageTab />)
      const missing = screen.getByRole('button', { name: '24 to 23 hours ago: insufficient coverage' })
      fireEvent.click(missing)
      expect(missing.getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByText(/24–23 h ago.*Not enough data/)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '1 to 0 hours ago: 1.23 GB/day' }))
      expect(screen.getByText(/1–0 h ago.*0.05 GB written/)).toBeTruthy()
    })

    it('flags a chip past rated life', () => {
      mocks.flash = flash({ lifeTime: [null, { minPercent: 100, maxPercent: null }], preEol: 'urgent' })
      render(<StorageTab />)
      expect(screen.getByText('Past rated life')).toBeTruthy()
      expect(screen.getByTestId('flash-card').className).toContain('border-danger-line')
    })
  })
})
