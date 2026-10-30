import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { createJournalStore } from '@/src/journal/store'
import { JournalService } from '@/src/journal/service'
import { withSideLock } from '@/src/hardware/sideLock'

const holder = vi.hoisted(() => ({ service: undefined as JournalService | undefined }))
vi.mock('@/src/journal/instance', () => ({ journalService: () => holder.service }))
const { journalRouter } = await import('../journal')
const caller = journalRouter.createCaller({})
let database: ReturnType<typeof migratedComfortDatabase>
beforeEach(() => {
  database = migratedComfortDatabase()
  holder.service = new JournalService({ store: createJournalStore(database), now: () => Date.parse('2026-10-25T10:00Z'), timeZone: () => 'UTC', withSideLock, presence: () => [] })
})
afterEach(() => database.close())
const input = { side: 'left' as const, date: '2026-10-24', expectedRevision: null,
  fields: { restfulness: 4, comfort: 'comfortable' as const, caffeine: false, alcohol: false, exercise: true, notes: 'Synthetic private note' } }

describe('journal contract', () => {
  it('returns selected records, explicit conflicts and side isolation', async () => {
    const saved = await caller.save(input)
    expect(await caller.get({ side: 'left', date: input.date })).toMatchObject({ selected: saved, entries: [saved] })
    expect(await caller.get({ side: 'right', date: input.date })).toMatchObject({ selected: { record: null }, entries: [] })
    await expect(caller.save(input)).rejects.toMatchObject({ code: 'CONFLICT' })
    await caller.save({ ...input, expectedRevision: saved.revision, fields: null })
    expect(await caller.get({ side: 'left', date: input.date })).toMatchObject({ selected: { record: null }, entries: [] })
  })
  it('validates dates and revisions, and masks errors that could contain private data', async () => {
    await expect(caller.get({ side: 'left', date: '2026-02-30' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.get({ side: 'left', days: 999 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.save({ ...input, date: '2026-10-26' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.save({ ...input, expectedRevision: 'unknown' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    database.exec('CREATE TRIGGER reject_private BEFORE INSERT ON journal_entries BEGIN SELECT RAISE(ABORT, \'Sensitive synthetic note\'); END')
    await expect(caller.save(input)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'The journal could not be read or saved. Your draft has not been discarded.' })
  })
})
