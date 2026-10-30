import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryFixture } from '../../../../tests/fixtures/importedHistory'
import { importedHistoryRouter } from '../importedHistory'

const caller = importedHistoryRouter.createCaller({})
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-history-router-'))
  vi.stubEnv('DATABASE_URL', join(directory, 'configuration.db'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('versioned history API', () => {
  it('reports absent snapshots and protects immutable pagination and side boundaries', async () => {
    expect(await caller.status({})).toMatchObject({ status: 'not_imported', snapshot: null })
    const input = { snapshotId: 'a'.repeat(64), side: 'left' as const, kind: 'vitals' as const,
      startTime: '2026-10-10T00:00:00Z', endTime: '2026-10-11T00:00:00Z' }
    await expect(caller.records(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    createHistoryFixture(directory)
    const snapshot = (await caller.status({})).snapshot
    if (!snapshot) throw new Error('Expected an imported fixture')
    await expect(caller.records(input)).rejects.toMatchObject({ code: 'CONFLICT' })
    const page = await caller.records({ ...input, snapshotId: snapshot.snapshotId, limit: 1 })
    expect(page.records).toHaveLength(1)
    if (!page.nextCursor) throw new Error('Expected another fixture page')
    await expect(caller.records({ ...input, snapshotId: snapshot.snapshotId, cursor: page.nextCursor, side: 'right' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.presence({ snapshotId: snapshot.snapshotId, side: 'right', id: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(caller.records({ ...input, snapshotId: snapshot.snapshotId, limit: 501 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
