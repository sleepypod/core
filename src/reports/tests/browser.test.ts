import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { readReportCopy, readReportLibrary } from '../browserContract'
import { MorningReportBrowserWorkspace, type ReportBrowserAccess, type ReportBrowserTransport } from '../browserWorkspace'
import { ownerReportWorkspace } from '../ownerBrowser'
import { reportFixture, reportNow } from './fixture'

function fixture() {
  const report = reportFixture().report
  const scope = { kind: 'legacy' as const, installationId: randomUUID() }
  const access: ReportBrowserAccess = { scope, revision: 'browser-account-1' }
  const receipt = { id: report.id, revision: randomUUID(), deleted: false, createdAt: report.createdAt, receivedAt: reportNow, updatedAt: reportNow }
  const envelope = { version: 1, generatedAt: reportNow, scope }
  const list = { ...envelope, reports: [{ ...receipt, provider: report.provider, model: report.model, source: report.source }] }
  const detail = { ...envelope, receipt, report }
  const transport: ReportBrowserTransport = { access: vi.fn(async () => structuredClone(access)),
    read: vi.fn(async id => structuredClone(id === null ? list : detail)) }
  return { report, scope, access, receipt, list, detail, transport, workspace: new MorningReportBrowserWorkspace(transport, () => reportNow) }
}

describe('shared report browser contract', () => {
  it('accepts saved metadata and a matching immutable report', () => {
    const sample = fixture()
    expect(readReportLibrary(sample.list, sample.scope, reportNow).reports).toHaveLength(1)
    expect(readReportCopy(sample.detail, sample.scope, sample.report.id, reportNow).report).toEqual(sample.report)
  })
  it('withholds wrong scope, duplicate IDs, future clocks, deleted list entries and mismatched detail', () => {
    const sample = fixture()
    const copies = [
      { ...sample.list, scope: { ...sample.scope, installationId: randomUUID() } },
      { ...sample.list, reports: [...sample.list.reports, ...sample.list.reports] },
      { ...sample.list, generatedAt: reportNow + 60001 },
      { ...sample.list, reports: [{ ...sample.list.reports[0], deleted: true }] },
      { ...sample.list, reports: [{ ...sample.list.reports[0], receivedAt: reportNow + 1 }] },
    ]
    for (const copy of copies) expect(() => readReportLibrary(copy, sample.scope, reportNow)).toThrow()
    for (const copy of [{ ...sample.detail, report: null }, { ...sample.detail, receipt: { ...sample.receipt, deleted: true } },
      { ...sample.detail, report: { ...sample.report, id: randomUUID() } }, { ...sample.detail, extra: 'account' }])
      expect(() => readReportCopy(copy, sample.scope, sample.report.id, reportNow)).toThrow()
  })
})

describe('shared report workspace lifetime', () => {
  it('opens the newest report through reads only and clears after a failed refresh', async () => {
    const sample = fixture()
    await sample.workspace.open()
    expect(sample.workspace.getSnapshot().report).toEqual(sample.report)
    expect(sample.transport.read).toHaveBeenNthCalledWith(1, null, expect.any(AbortSignal))
    expect(sample.transport.read).toHaveBeenNthCalledWith(2, sample.report.id, expect.any(AbortSignal))
    vi.mocked(sample.transport.read).mockRejectedValue(new Error('unavailable'))
    await sample.workspace.open()
    expect(sample.workspace.getSnapshot()).toMatchObject({ report: null, reports: null, busy: false, error: expect.any(String) })
  })
  it('never restores a private report from a late completion after hide or dispose', async () => {
    for (const action of ['clear', 'dispose'] as const) {
      const sample = fixture()
      let release: (value: unknown) => void = () => {}
      vi.mocked(sample.transport.read).mockImplementationOnce(() => new Promise((resolve) => {
        release = resolve
      }))
      const pending = sample.workspace.open()
      await vi.waitFor(() => expect(sample.transport.read).toHaveBeenCalled())
      sample.workspace[action]()
      release(sample.list)
      await pending
      expect(sample.workspace.getSnapshot().report).toBeNull()
      expect(sample.transport.read).toHaveBeenCalledTimes(1)
    }
  })
  it('rejects account switches before delivery and keeps its original account after closing', async () => {
    const sample = fixture()
    vi.mocked(sample.transport.access).mockResolvedValueOnce(sample.access).mockResolvedValue({ ...sample.access, revision: 'other-account' })
    await sample.workspace.open()
    expect(sample.workspace.getSnapshot().report).toBeNull()
    sample.workspace.clear()
    await sample.workspace.open()
    expect(sample.workspace.getSnapshot().report).toBeNull()
    expect(sample.transport.read).toHaveBeenCalledTimes(2)
  })
  it('withdraws a displayed report when periodic access is revoked or its copy changes', async () => {
    for (const reason of ['account', 'delete', 'revision']) {
      const sample = fixture()
      await sample.workspace.open()
      if (reason === 'account') vi.mocked(sample.transport.access).mockResolvedValue({ ...sample.access, revision: 'revoked' })
      else vi.mocked(sample.transport.read).mockResolvedValue(reason === 'delete'
        ? { ...sample.detail, report: null, receipt: { ...sample.receipt, deleted: true } }
        : { ...sample.detail, receipt: { ...sample.receipt, revision: randomUUID() } })
      await sample.workspace.checkAccess()
      expect(sample.workspace.getSnapshot()).toMatchObject({ report: null, reports: null, error: expect.any(String) })
    }
  })
  it('checks access again after periodic report delivery', async () => {
    const sample = fixture()
    await sample.workspace.open()
    vi.mocked(sample.transport.access).mockResolvedValueOnce(sample.access).mockResolvedValue({ ...sample.access, revision: 'new-account' })
    await sample.workspace.checkAccess()
    expect(sample.workspace.getSnapshot().report).toBeNull()
  })
  it('shows a confirmed withdrawal without recreating or reading another report', async () => {
    const sample = fixture()
    vi.mocked(sample.transport.read).mockImplementation(async id => id === null
      ? { ...sample.list, reports: [] }
      : { ...sample.detail, report: null, receipt: { ...sample.receipt, deleted: true } })
    await sample.workspace.open(sample.report.id)
    expect(sample.workspace.getSnapshot()).toMatchObject({ report: null, withdrawn: true, selectedId: sample.report.id })
  })
})

describe('owner report browser transport', () => {
  it('pins the challenged installation and browser account, using only fixed same-origin GETs', async () => {
    const sample = fixture()
    const requests: Array<{ url: string, init: RequestInit | undefined }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url === '/api/auth/session') return Response.json({ configured: true, authenticated: true, privacyAvailable: true,
        personalSessionActive: false, personalConnectionRequired: false, browserScopeRevision: 'browser-account-1' })
      if (url.startsWith('/api/v1/connection?')) return Response.json({ schemaVersion: 1, controller: 'sleepypod-core',
        installationId: sample.scope.installationId, challenge: new URL(url, 'http://localhost').searchParams.get('challenge') })
      return Response.json(url === '/api/v1/reports' ? sample.list : sample.detail)
    })
    const workspace = ownerReportWorkspace(fetcher)
    await workspace.open()
    expect(workspace.getSnapshot().report).toEqual(sample.report)
    for (const { url, init } of requests) {
      expect(url).toMatch(/^\/api\/(?:auth\/session|v1\/(?:connection\?challenge=[A-Za-z0-9_-]{43}|reports(?:\/[a-f0-9-]{36})?))$/)
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
      expect(init?.body).toBeUndefined()
    }
  })
  it('rejects an owner fallback from personal mode, HTML and streamed oversized responses', async () => {
    for (const response of [Response.json({ configured: true, authenticated: true, privacyAvailable: true,
      personalSessionActive: true, personalConnectionRequired: true, browserScopeRevision: 'personal' }),
    new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response(new Uint8Array(512 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })]) {
      const fetcher = vi.fn(async () => response)
      const workspace = ownerReportWorkspace(fetcher)
      await workspace.open()
      expect(workspace.getSnapshot().report).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
})
