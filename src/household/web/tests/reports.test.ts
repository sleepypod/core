import { describe, expect, it, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import { personalReportWorkspace } from '../reports'
import { PersonalBrowserClient } from '../client'
import { reportFixture, reportNow } from '@/src/reports/tests/fixture'
import { randomUUID } from 'node:crypto'
import { householdSessionSchema } from '../../contract'

describe('personal report reads', () => {
  const session = householdSessionSchema.parse({ ...preparation.ownerSession, capabilities: { ...preparation.ownerSession.capabilities, personalReports: true } })
  const scope = { podId: session.podId, householdId: session.householdId, accountId: session.accountId, sleeperId: session.selfSleeperId,
    sessionRevision: session.sessionRevision, householdRevision: session.householdRevision, assignmentRevision: session.assignmentRevision }
  it('reads only the pinned personal library with the sleeper header', async () => {
    const report = reportFixture().report
    const receipt = { id: report.id, revision: randomUUID(), deleted: false, createdAt: report.createdAt, receivedAt: reportNow, updatedAt: reportNow }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input) === '/api/v1/household/session'
      ? session
      : String(input) === '/api/v1/me/reports'
        ? { version: 1, generatedAt: reportNow, scope,
            reports: [{ ...receipt, provider: report.provider, model: report.model, source: report.source }] }
        : { version: 1, generatedAt: reportNow, scope, receipt, report }))
    const client = new PersonalBrowserClient(session, fetcher)
    const workspace = personalReportWorkspace(session, client)
    await workspace.open()
    expect(workspace.getSnapshot().report).toEqual(report)
    for (const call of fetcher.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[0]).toMatch(/^\/api\/v1\/(?:household\/session|me\/reports(?:\/[a-f0-9-]{36})?)$/)
      expect(call[1].headers).toMatchObject({ 'X-Sleepypod-Sleeper-Id': session.selfSleeperId })
    }
    for (const path of ['reports', `reports/${report.id}`, 'me/reports?account=other', 'me/reports/../reports'])
      await expect(client.read(path)).rejects.toThrow()
    await expect(client.read('me/reports', 'PUT', {})).rejects.toThrow()
  })
  it('rejects a changed household revision or disabled capability before reading a report', async () => {
    for (const current of [{ ...session, householdRevision: session.householdRevision + 1 },
      { ...session, capabilities: { ...session.capabilities, personalReports: false } }]) {
      const read = vi.fn(async () => current)
      const workspace = personalReportWorkspace(session, { read, dispose: () => {} })
      await workspace.open()
      expect(workspace.getSnapshot().report).toBeNull()
      expect(read).toHaveBeenCalledExactlyOnceWith('household/session')
    }
  })
})
