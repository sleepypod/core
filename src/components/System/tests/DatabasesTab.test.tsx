import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  overview: undefined as unknown,
  rows: undefined as unknown,
  rowsInput: [] as unknown[],
  check: vi.fn(),
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ databases: { overview: { invalidate: vi.fn() } } }),
    databases: {
      overview: { useQuery: () => ({ data: mocks.overview, isLoading: false, error: null }) },
      checkIntegrity: { useMutation: () => ({ mutate: mocks.check, isPending: false, error: null }) },
      rows: {
        useQuery: (input: unknown) => {
          mocks.rowsInput.push(input)
          return { data: mocks.rows, isLoading: false, error: null }
        },
      },
    },
  },
}))

import { DatabasesTab } from '../DatabasesTab'

const NOW = Date.UTC(2026, 8, 28, 19, 5)
const MB = 1024 * 1024
const hourly = (fill: (h: number) => number) => Array.from({ length: 24 }, (_, h) => fill(h))
const table = (over: Record<string, unknown>) => ({
  name: 't', rows: 100, bytes: MB, timeColumn: 'timestamp', timeInMs: false, lastWriteAt: NOW - 60_000, oldestAt: NOW - 86_400_000,
  hourly: hourly(() => 5), rows24h: 120, retention: null, ...over,
})

beforeEach(() => {
  mocks.rowsInput = []
  mocks.check.mockReset()
  mocks.overview = {
    at: NOW,
    hoursFrom: NOW - 23 * 3_600_000,
    dataDir: '/persistent/sleepypod-data',
    disk: { totalBytes: 15e9, availableBytes: 7.5e9 },
    lastBackupAt: null,
    occupiedHours: [20, 21, 22, 23],
    databases: [
      {
        key: 'sleepypod', path: '/persistent/sleepypod-data/sleepypod.db', fileBytes: 9 * MB, walBytes: 4 * MB, pageSize: 4096, freePages: 0, walAutocheckpoint: 1000,
        integrity: { scheduled: { status: 'ok', checkedAt: new Date(NOW - 38 * 60_000).toISOString(), latencyMs: 212 }, manual: null },
        migrations: { applied: 19, known: 17, latestTag: '0016_hardware_deadline', appliedTag: null },
        tables: [
          table({ name: 'automation_runs', timeColumn: 'fired_at', timeInMs: true, bytes: 9 * MB, rows: 134_778 }),
          table({ name: 'device_settings', rows: 1, rows24h: 0, hourly: hourly(() => 0), bytes: 4096 }),
        ],
      },
      {
        key: 'biometrics', path: '/persistent/sleepypod-data/biometrics.db', fileBytes: 60 * MB, walBytes: 6 * MB, pageSize: 4096, freePages: 324, walAutocheckpoint: 1000,
        integrity: { scheduled: { status: 'pending', checkedAt: null, latencyMs: 0 }, manual: null },
        migrations: { applied: 17, known: 17, latestTag: '0016_x', appliedTag: '0016_x' },
        tables: [
          table({ name: 'vitals', bytes: 7 * MB, hourly: hourly(h => (h < 20 ? 4 : 0)), retention: { days: 90, by: 'daily retention pass' } }),
          table({ name: 'cap_sense_frames', bytes: 9 * MB, retention: { days: 2, by: 'cap frame writer' } }),
        ],
      },
    ],
  }
  mocks.rows = {
    columns: ['id', 'side', 'timestamp', 'heart_rate'],
    timeColumn: 'timestamp',
    rows: [[41207, 'left', 1790631923, 61]],
    total: 41207,
  }
})

describe('DatabasesTab', () => {
  it('shows both files with integrity, WAL, migrations and a strip per table', () => {
    render(<DatabasesTab />)
    const main = screen.getByTestId('db-sleepypod')
    expect(main.textContent).toContain('sleepypod.db')
    expect(main.textContent).toContain('OK')
    expect(main.textContent).toContain('19 / 17')
    expect(main.textContent).toContain('2 applied by another build')

    const bio = screen.getByTestId('db-biometrics')
    expect(bio.textContent).toContain('Pending')
    expect(bio.textContent).toContain('hourly check runs 30 s after start')
    expect(within(bio).getByTestId('table-cap_sense_frames').textContent).toContain('48 h')
  })

  it('flags unpruned growth and vitals that stopped while the pod was occupied', () => {
    render(<DatabasesTab />)
    expect(within(screen.getByTestId('table-automation_runs')).getByText('not pruned')).toBeTruthy()
    expect(within(screen.getByTestId('table-device_settings')).queryByText('not pruned')).toBeNull()
    expect(screen.getByTestId('table-vitals').textContent).toContain('pod occupied')
    expect(screen.getByTestId('storage-outlook').textContent).toContain('automation_runs isn’t pruned')
  })

  it('reads out the projected size under the pointer on the outlook chart', () => {
    render(<DatabasesTab />)
    const svg = screen.getByRole('img', { name: 'Projected database size' })
    // Without ResizeObserver the chart falls back to 640px: a 52px axis gutter, then 580px of plot.
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 640, height: 220, right: 640, bottom: 220, toJSON: () => ({}) })
    fireEvent.pointerMove(svg, { clientX: 52 + 290, clientY: 50 })
    expect(screen.getByTestId('outlook-hover').textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2} · [\d.]+ [KMG]?B$/)
    fireEvent.pointerMove(svg, { clientX: 10, clientY: 50 })
    expect(screen.queryByTestId('outlook-hover')).toBeNull()
    fireEvent.pointerMove(svg, { clientX: 52 + 290, clientY: 50 })
    fireEvent.pointerLeave(svg)
    expect(screen.queryByTestId('outlook-hover')).toBeNull()
  })

  it('runs an integrity check on demand and links the backup', () => {
    render(<DatabasesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Run integrity check' }))
    expect(mocks.check).toHaveBeenCalled()
    const links = screen.getAllByRole('link', { name: /Download backup/ })
    expect(links[0].getAttribute('href')).toBe('/api/db-backup')
    expect(screen.getByText('last downloaded: never')).toBeTruthy()
  })

  it('browses rows read-only, newest first, with a column filter', () => {
    render(<DatabasesTab />)
    const browser = screen.getByTestId('row-browser')
    expect(mocks.rowsInput.at(-1)).toMatchObject({ db: 'biometrics', table: 'vitals', offset: 0 })
    expect(browser.textContent).toContain('READ-ONLY')
    expect(browser.textContent).toMatch(/2026-09-2\d \d\d:\d\d:\d\d/)
    expect(browser.textContent).toContain('1–10 of 41,207')

    fireEvent.click(within(browser).getByRole('button', { name: 'Filter' }))
    fireEvent.change(within(browser).getByLabelText('Filter value'), { target: { value: 'left' } })
    fireEvent.click(within(browser).getByRole('button', { name: 'Apply' }))
    expect(mocks.rowsInput.at(-1)).toMatchObject({ column: 'side', value: 'left' })
    expect(browser.textContent).toContain('side = left')

    fireEvent.click(within(browser).getByRole('button', { name: 'Older rows' }))
    expect(mocks.rowsInput.at(-1)).toMatchObject({ offset: 10 })
  })
})
