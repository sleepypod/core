import { describe, expect, it, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import { householdSessionSchema } from '../../contract'
import { PersonalLearningWorkspace } from '../learning'
import { learningReading, learningRecordLabel } from '../learningPresentation'
import { learningFixture } from './learningFixture'
import { PersonalWebError } from '../protocol'
import { learningRemovalRequestSchema, type LearningRemovalReceipt } from '../../learningRemovalContract'
import type { PersonalWebTransport } from '../client'

function setup() {
  const session = householdSessionSchema.parse({ ...preparation.ownerSession,
    capabilities: { ...preparation.ownerSession.capabilities, personalLearningArchive: true, personalLearningRemoval: true } })
  const examples = learningFixture(session)
  const read: PersonalWebTransport['read'] = async path => structuredClone(path === 'household/session'
    ? session
    : path.startsWith('me/learning/archives?')
      ? examples.archives
      : path.startsWith('me/learning/records?') ? examples.records : examples.detail)
  const client = { read: vi.fn(read), dispose: vi.fn() }, invalidated = vi.fn()
  const workspace = new PersonalLearningWorkspace({ session: structuredClone(session), client, invalidated })
  return { session, examples, read, client, invalidated, workspace }
}
async function open(fixture: ReturnType<typeof setup>) {
  await fixture.workspace.load()
  await fixture.workspace.openArchive(fixture.examples.archiveId)
}

describe('private learning library browser state', () => {
  async function removalSetup(drop: 'before' | 'after' | null = null) {
    const fixture = setup()
    let receipt: LearningRemovalReceipt | null = null
    const response = () => ({ version: 1, generatedAt: fixture.examples.detail.generatedAt,
      scope: fixture.examples.detail.scope, interpretation: 'archived_copy_removal_not_source_deletion', receipt })
    fixture.client.read.mockImplementation(async (path, method, body) => {
      if (method === 'POST') {
        const input = learningRemovalRequestSchema.parse(body)
        if (drop === 'before') throw new PersonalWebError('uncertain', 'Example disconnect')
        receipt = { requestId: input.requestId, recordId: input.recordId, archiveId: input.archiveId,
          payloadHash: input.expectedPayloadHash, removedAt: fixture.examples.detail.generatedAt, outcome: 'content_removed' }
        fixture.examples.detail.payload = null
        fixture.examples.detail.redacted = true
        fixture.examples.records.records[0].redacted = true
        if (drop === 'after') throw new PersonalWebError('uncertain', 'Example lost reply')
        return structuredClone(response())
      }
      if (path.startsWith('me/learning/requests/')) return structuredClone(response())
      return fixture.read(path)
    })
    await open(fixture)
    await fixture.workspace.openRecord(fixture.examples.recordId)
    return fixture
  }

  it('requires explicit removal review and cancel never sends a request', async () => {
    const fixture = await removalSetup()
    await fixture.workspace.confirmRemoval()
    fixture.workspace.reviewRemoval()
    expect(fixture.workspace.getSnapshot().removalStatus).toBe('review')
    fixture.workspace.cancelRemoval()
    expect(fixture.workspace.getSnapshot().detail?.payload).not.toBeNull()
    expect(fixture.workspace.getSnapshot().removalRequest).toBeNull()
    expect(fixture.client.read.mock.calls.some(([, method]) => method === 'POST')).toBe(false)
  })

  it('confirms removal once and never shows the removed payload or download again', async () => {
    const fixture = await removalSetup()
    fixture.workspace.reviewRemoval()
    await Promise.all([fixture.workspace.confirmRemoval(), fixture.workspace.confirmRemoval()])
    expect(fixture.client.read.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ detail: null, removalStatus: 'removed', busy: false })
    expect(fixture.workspace.getSnapshot().records?.records[0].redacted).toBe(true)
    await fixture.workspace.openRecord(fixture.examples.recordId)
    expect(fixture.workspace.getSnapshot().detail).toMatchObject({ payload: null, redacted: true })
  })

  it.each(['before', 'after'] as const)('reconciles a lost %s reply by reading, never resending', async (drop) => {
    const fixture = await removalSetup(drop)
    fixture.workspace.reviewRemoval()
    await fixture.workspace.confirmRemoval()
    expect(fixture.workspace.getSnapshot()).toMatchObject({ detail: null, removalStatus: 'uncertain', busy: false })
    await fixture.workspace.confirmRemoval()
    await fixture.workspace.checkRemoval()
    expect(fixture.client.read.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1)
    expect(fixture.workspace.getSnapshot().removalStatus).toBe(drop === 'after' ? 'removed' : 'uncertain')
    if (drop === 'before') expect(fixture.workspace.getSnapshot().error).toContain('still unknown')
  })

  it.each(['assignment', 'disabled'] as const)('withdraws a removal review when %s changes before submission', async (change) => {
    const fixture = await removalSetup()
    fixture.workspace.reviewRemoval()
    if (change === 'assignment') fixture.session.assignmentRevision += 1
    else fixture.session.capabilities.personalLearningRemoval = false
    await fixture.workspace.confirmRemoval()
    expect(fixture.client.read.mock.calls.some(([, method]) => method === 'POST')).toBe(false)
    expect(fixture.workspace.getSnapshot().removalRequest).toBeNull()
    expect(fixture.workspace.getSnapshot().detail).toBeNull()
  })

  it('discards an in-flight removal reply after the library is hidden', async () => {
    const fixture = await removalSetup()
    fixture.workspace.reviewRemoval()
    let finish: (value: unknown) => void = () => {}
    const held = new Promise((resolve) => {
      finish = resolve
    })
    fixture.client.read.mockImplementation((path, method) => method === 'POST' ? held : fixture.read(path))
    const removing = fixture.workspace.confirmRemoval()
    await vi.waitFor(() => expect(fixture.client.read.mock.calls.some(([, method]) => method === 'POST')).toBe(true))
    fixture.workspace.clear()
    finish({ private: 'discard this response' })
    await removing
    expect(fixture.workspace.getSnapshot()).toMatchObject({ detail: null, records: null, removalRequest: null, removalStatus: null })
  })

  it('loads only after explicit reads and verifies the account before and after every page and record', async () => {
    const fixture = setup()
    expect(fixture.client.read).not.toHaveBeenCalled()
    await open(fixture)
    await fixture.workspace.openRecord(fixture.examples.recordId)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ archives: fixture.examples.archives,
      records: fixture.examples.records, detail: fixture.examples.detail, busy: false, error: null })
    const paths = fixture.client.read.mock.calls.map(([path]) => path)
    expect(paths).toHaveLength(9)
    expect(paths.filter(path => path === 'household/session')).toHaveLength(6)
    expect(paths.every(path => path === 'household/session' || path.startsWith('me/learning/'))).toBe(true)
    expect(fixture.invalidated).not.toHaveBeenCalled()
  })

  it.each(['scope', 'query', 'hash', 'recordIdentity', 'recordSource'])('withdraws malformed or changed %s instead of showing a mismatched record', async (change) => {
    const fixture = setup()
    await fixture.workspace.load()
    if (change === 'scope') fixture.examples.records.scope.sleeperId = '30000000-0000-4000-8000-000000000099'
    if (change === 'query') fixture.examples.records.query.after = 1
    if (change === 'hash') fixture.examples.records.contentHash = 'f'.repeat(64)
    await fixture.workspace.openArchive(fixture.examples.archiveId)
    if (change === 'recordIdentity') fixture.examples.detail.recordId = '30000000-0000-4000-8000-000000000099'
    if (change === 'recordSource') fixture.examples.detail.sourceSide = 'right'
    if (change.startsWith('record')) await fixture.workspace.openRecord(fixture.examples.recordId)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ archives: null, records: null, detail: null, busy: false })
    if (change === 'scope') expect(fixture.invalidated).toHaveBeenCalledOnce()
    else expect(fixture.workspace.getSnapshot().error).toContain('Reload')
  })

  it('replaces record pages without keeping a second private page', async () => {
    const fixture = setup()
    fixture.examples.records.records = Array.from({ length: 20 }, (_, index) => ({ ...fixture.examples.records.records[0],
      recordId: `30000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`, ordinal: index + 1 }))
    fixture.examples.records.nextOrdinal = 20
    await open(fixture)
    fixture.examples.records.query.after = 20
    fixture.examples.records.records = [{ ...fixture.examples.records.records[0], ordinal: 21 }]
    fixture.examples.records.nextOrdinal = null
    await fixture.workspace.olderRecords()
    expect(fixture.workspace.getSnapshot().records?.records).toHaveLength(1)
    expect(fixture.client.read.mock.calls.some(([path]) => path.includes('after=20'))).toBe(true)
    fixture.examples.records.query.after = 0
    await fixture.workspace.openArchive(fixture.examples.archiveId)
    expect(fixture.workspace.getSnapshot().records?.query.after).toBe(0)
  })

  it('withdraws a repeated page rather than displaying the same records as the next page', async () => {
    const fixture = setup()
    fixture.examples.records.records = Array.from({ length: 20 }, (_, index) => ({ ...fixture.examples.records.records[0],
      recordId: `30000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`, ordinal: index + 1 }))
    fixture.examples.records.nextOrdinal = 20
    await open(fixture)
    await fixture.workspace.olderRecords()
    expect(fixture.workspace.getSnapshot()).toMatchObject({ archives: null, records: null, detail: null })
    expect(fixture.workspace.getSnapshot().error).toContain('Reload')
  })

  it.each(['disabled', 'account', 'assignment', 'revision'])('clears already displayed notes after %s changes', async (change) => {
    const fixture = setup()
    await open(fixture)
    await fixture.workspace.openRecord(fixture.examples.recordId)
    if (change === 'disabled') fixture.session.capabilities.personalLearningArchive = false
    if (change === 'account') fixture.session.accountId = '30000000-0000-4000-8000-000000000099'
    if (change === 'assignment') fixture.session.assignmentRevision += 1
    if (change === 'revision') fixture.session.householdRevision += 1
    await fixture.workspace.checkAccess()
    expect(fixture.workspace.getSnapshot()).toMatchObject({ archives: null, records: null, detail: null })
    if (change !== 'disabled') expect(fixture.invalidated).toHaveBeenCalledOnce()
    else expect(fixture.workspace.getSnapshot().available).toBe(false)
  })

  it.each(['clear', 'dispose'] as const)('discards an in-flight private note on %s', async (action) => {
    const fixture = setup()
    await open(fixture)
    let finish: (value: unknown) => void = () => {
      throw new Error('Request has not started')
    }
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    fixture.client.read.mockImplementation(path => path.includes(`/records/${fixture.examples.recordId}`) ? pending : fixture.read(path))
    const reading = fixture.workspace.openRecord(fixture.examples.recordId)
    await vi.waitFor(() => expect(fixture.client.read.mock.calls.some(([path]) => path.includes(`/records/${fixture.examples.recordId}`))).toBe(true))
    fixture.workspace[action]()
    finish(fixture.examples.detail)
    await reading
    expect(fixture.workspace.getSnapshot()).toMatchObject({ archives: null, records: null, detail: null, busy: false })
    if (action === 'dispose') expect(fixture.client.dispose).toHaveBeenCalledOnce()
  })

  it('handles missing and failed reads without exposing peer text or retrying', async () => {
    const fixture = setup()
    await open(fixture)
    fixture.client.read.mockRejectedValue(new PersonalWebError('missing', 'private server message'))
    await fixture.workspace.openRecord(fixture.examples.recordId)
    expect(fixture.workspace.getSnapshot().error).not.toContain('private server')
    expect(fixture.workspace.getSnapshot().records).toBeNull()
  })

  it('renders known journal fields while retaining exact unknown source bytes for download', () => {
    const fixture = setup()
    const reading = learningReading(fixture.examples.detail)
    expect(reading.note).toBe('Felt comfortable after an earlier bedtime.')
    expect(reading.facts).toEqual([{ label: 'Comfort', value: 'Comfortable' }, { label: 'Restfulness', value: '4 of 5' }])
    expect(learningRecordLabel(fixture.examples.records.records[0])).toMatch(/Journal entry.+2026/)
    fixture.examples.detail.payload = '{"side":"right","id":9007199254740993,"record":"unrecognized"}'
    expect(learningReading(fixture.examples.detail)).toMatchObject({ note: null, facts: [] })
    expect(fixture.examples.detail.payload).toContain('9007199254740993')
    fixture.examples.detail.redacted = true
    fixture.examples.detail.payload = null
    expect(learningReading(fixture.examples.detail).note).toBeNull()
  })
})
