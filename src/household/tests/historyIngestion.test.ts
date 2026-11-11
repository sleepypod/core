import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalHistoryIngestion } from '../historyIngestion'
import type { PresenceHistoryImporter } from '../presenceHistoryImporter'

const baseline = Date.UTC(2026, 10, 11)
const minute = 60_000
type Page = ReturnType<PresenceHistoryImporter['scan']>
const page = (watermark = 100, nextCursor: Page['nextCursor'] = null): Page => ({
  counts: { scanned: 0, admitted: 0, unchanged: 0, withheld: 0 }, withheldReasons: {}, watermark, nextCursor,
})
let service: PersonalHistoryIngestion
let enabled: ReturnType<typeof vi.fn<() => boolean>>
let target: ReturnType<typeof vi.fn<() => { householdId: string, datasetId: string, reviewReceiptId: string } | null>>
let scan: ReturnType<typeof vi.fn<PresenceHistoryImporter['scan']>>
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(baseline)
  enabled = vi.fn(() => true)
  target = vi.fn(() => ({ householdId: randomUUID(), datasetId: randomUUID(), reviewReceiptId: randomUUID() }))
  target.mockReturnValue(target())
  scan = vi.fn(() => page())
  service = new PersonalHistoryIngestion({ enabled, target, scan })
})
afterEach(() => {
  service.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const advance = (duration: number) => vi.advanceTimersByTime(duration)

describe('bounded personal-history ingestion', () => {
  it('defers its first page, starts once and bounds every page with one timer', () => {
    expect(service.status().state).toBe('stopped')
    service.start()
    service.start()
    advance(4999)
    expect(scan).not.toHaveBeenCalled()
    advance(1)
    expect(scan).toHaveBeenCalledExactlyOnceWith({ householdId: target()?.householdId, datasetId: target()?.datasetId, afterId: 0, limit: 25 })
    expect(service.status()).toMatchObject({ state: 'ready', lastCompleteAuditAt: baseline + 5000, consecutiveFailures: 0 })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('requires both the runtime switch and an existing reviewed target before reading any rows', () => {
    enabled.mockReturnValue(false)
    service.start()
    advance(5000)
    expect(target).toHaveBeenCalledTimes(1) // fixture initialization only
    expect(service.status().state).toBe('disabled')
    enabled.mockReturnValue(true)
    target.mockReturnValue(null)
    advance(30_000)
    expect(service.status().state).toBe('awaiting_review')
    expect(scan).not.toHaveBeenCalled()
    expect(service.status().lastSuccessfulPageAt).toBeNull()
  })

  it('completes a frozen catch-up snapshot before tailing new IDs', () => {
    scan.mockReturnValueOnce(page(100, { afterId: 25, watermark: 100 }))
      .mockReturnValueOnce(page(100)).mockReturnValueOnce(page(101))
    service.start()
    advance(5000)
    expect(service.status().lastCompleteAuditAt).toBeNull()
    advance(30_000)
    expect(scan.mock.calls[1][0]).toMatchObject({ cursor: { afterId: 25, watermark: 100 }, limit: 25 })
    advance(30_000)
    expect(scan.mock.calls[2][0]).toMatchObject({ afterId: 100, limit: 25 })
    advance(30_000)
    expect(scan.mock.calls[3][0]).toMatchObject({ afterId: 101 })
  })

  it('audits older rows periodically without delaying the next tail page', () => {
    service.start()
    advance(5000)
    advance(15 * minute - 30_000)
    expect(scan.mock.calls.filter(([input]) => (input as { afterId?: number }).afterId === 0)).toHaveLength(1)
    scan.mockReturnValueOnce(page(101)).mockReturnValueOnce(page(101, { afterId: 25, watermark: 101 }))
    advance(30_000)
    expect(scan.mock.calls.at(-2)?.[0]).toMatchObject({ afterId: 100 })
    expect(scan.mock.calls.at(-1)?.[0]).toMatchObject({ afterId: 0 })
    scan.mockReturnValueOnce(page(102)).mockReturnValueOnce(page(101))
    advance(30_000)
    expect(scan.mock.calls.at(-2)?.[0]).toMatchObject({ afterId: 101 })
    expect(scan.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: { afterId: 25, watermark: 101 } })
    expect(service.status().lastCompleteAuditAt).toBe(Date.now())
  })

  it('replays the same cursor after a partial commit and backs off failures without leaking their text', () => {
    const logger = vi.spyOn(console, 'error')
    scan.mockReturnValueOnce(page(100, { afterId: 25, watermark: 100 }))
      .mockImplementationOnce(() => { throw new Error('private source row and path') })
    service.start()
    advance(5000)
    advance(30_000)
    expect(service.status()).toMatchObject({ state: 'unavailable', consecutiveFailures: 1, lastSuccessfulPageAt: baseline + 5000 })
    advance(59_999)
    expect(scan).toHaveBeenCalledTimes(2)
    advance(1)
    expect(scan.mock.calls[2][0]).toEqual(scan.mock.calls[1][0])
    expect(service.status()).toMatchObject({ state: 'ready', consecutiveFailures: 0 })
    expect(JSON.stringify(service.status())).not.toContain('private')
    expect(logger).not.toHaveBeenCalled()
  })

  it('caps repeated failure retries and resumes at the normal interval after recovery', () => {
    scan.mockImplementation(() => {
      throw new Error('unavailable')
    })
    service.start()
    advance(60 * minute)
    expect(scan.mock.calls.length).toBeLessThan(10)
    expect(service.status().state).toBe('unavailable')
    scan.mockReturnValue(page())
    advance(15 * minute)
    expect(service.status().state).toBe('ready')
    const previous = target.mock.calls.length
    advance(30_000)
    expect(target.mock.calls.length).toBe(previous + 1)
  })

  it('restarts both lanes when a target changes rather than reusing another dataset checkpoint', () => {
    service.start()
    advance(5000)
    const changed = { householdId: randomUUID(), datasetId: randomUUID(), reviewReceiptId: randomUUID() }
    target.mockReturnValue(changed)
    advance(30_000)
    expect(scan.mock.calls.at(-1)?.[0]).toEqual({ householdId: changed.householdId, datasetId: changed.datasetId, afterId: 0, limit: 25 })
  })

  it('clears progress when review disappears or the runtime is disabled', () => {
    service.start()
    advance(5000)
    const original = target()
    target.mockReturnValue(null)
    advance(30_000)
    expect(service.status()).toMatchObject({ state: 'awaiting_review', lastSuccessfulPageAt: null, lastCompleteAuditAt: null })
    target.mockReturnValue(original)
    advance(30_000)
    expect(scan.mock.calls.at(-1)?.[0]).toMatchObject({ afterId: 0 })
    enabled.mockReturnValue(false)
    advance(30_000)
    expect(service.status()).toMatchObject({ state: 'disabled', lastSuccessfulPageAt: null })
  })

  it('stops before database shutdown and starts with a full replay when restarted', () => {
    service.start()
    advance(5000)
    service.stop()
    advance(60 * minute)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    service.start()
    advance(5000)
    expect(scan.mock.calls[1][0]).toMatchObject({ afterId: 0 })
  })

  it('treats malformed or failing target lookup as unavailable without scanning', () => {
    target.mockReturnValue({ householdId: 'not-an-id', datasetId: randomUUID(), reviewReceiptId: randomUUID() })
    service.start()
    advance(5000)
    expect(service.status().state).toBe('unavailable')
    expect(scan).not.toHaveBeenCalled()
    target.mockImplementation(() => {
      throw new Error('private SQL')
    })
    advance(60_000)
    expect(service.status().consecutiveFailures).toBe(2)
    expect(scan).not.toHaveBeenCalled()
  })

  it('does not expose mutable internal status', () => {
    const returned = service.status()
    returned.state = 'ready'
    returned.lastCompleteAuditAt = baseline
    expect(service.status()).toMatchObject({ state: 'stopped', lastCompleteAuditAt: null })
  })

  it('retains a failed audit cursor while later arrivals continue through their own checkpoint', () => {
    service.start()
    advance(5000)
    advance(15 * minute - 30_000)
    scan.mockReturnValueOnce(page(101)).mockReturnValueOnce(page(101, { afterId: 25, watermark: 101 }))
    advance(30_000)
    scan.mockReturnValueOnce(page(102)).mockImplementationOnce(() => {
      throw new Error('audit interrupted after commit')
    })
    advance(30_000)
    const failedAudit = scan.mock.calls.at(-1)?.[0]
    expect(failedAudit).toMatchObject({ cursor: { afterId: 25, watermark: 101 } })
    scan.mockReturnValueOnce(page(103)).mockReturnValueOnce(page(101))
    advance(60_000)
    expect(scan.mock.calls.at(-2)?.[0]).toMatchObject({ afterId: 102 })
    expect(scan.mock.calls.at(-1)?.[0]).toEqual(failedAudit)
    expect(service.status().state).toBe('ready')
  })
})
