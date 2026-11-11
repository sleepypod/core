import { expect, it, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import { householdSessionSchema } from '../../contract'
import { personalJournalWriteSchema, type PersonalJournalReceipt, type PersonalJournalSelection } from '../../personalJournalContract'
import { PersonalJournalWorkspace } from '../journal'
import { PersonalWebError } from '../protocol'
import { personalJournalPath } from '../journalPaths'
import { personalJournalPatterns } from '../../personalJournalPatterns'

function setup() {
  const session = householdSessionSchema.parse({ ...preparation.ownerSession,
    capabilities: { ...preparation.ownerSession.capabilities, personalJournal: true, personalJournalPatterns: true } })
  const zone = 'America/Los_Angeles', now = Date.parse('2026-11-11T12:00:00Z')
  const entries = new Map<string, PersonalJournalSelection>(), receipts = new Map<string, PersonalJournalReceipt>()
  const envelope = () => ({ version: 1, generatedAt: now, interpretation: 'personal_self_report_not_sleep_measurement',
    scope: { podId: session.podId, householdId: session.householdId, accountId: session.accountId,
      sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
      assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision } })
  const read = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path === 'household/session') return structuredClone(session)
    if (method === 'POST') {
      const request = personalJournalWriteSchema.parse(body)
      const receipt: PersonalJournalReceipt = { requestId: request.requestId, date: request.date,
        revision: '40000000-0000-4000-8000-000000000001', timeZone: request.expectedTimeZone,
        savedAt: now, outcome: request.fields ? 'saved' : 'deleted' }
      entries.set(request.date, { date: request.date, revision: receipt.revision, timeZone: zone,
        record: request.fields ? { date: request.date, timeZone: zone, fields: request.fields, createdAt: now, updatedAt: now } : null })
      receipts.set(request.requestId, receipt)
      return { ...envelope(), receipt }
    }
    if (path.startsWith('me/journal/requests/')) return { ...envelope(), receipt: receipts.get(path.split('/').at(-1) ?? '') ?? null }
    if (path.startsWith('me/journal/patterns?')) {
      const query = Object.fromEntries(new URLSearchParams(path.split('?')[1]))
      return { ...envelope(), query, ...personalJournalPatterns([...entries.values()].filter(item => item.date >= query.from && item.date <= query.through), now) }
    }
    const date = new URLSearchParams(path.split('?')[1]).get('date') ?? ''
    return { ...envelope(), currentTimeZone: zone, query: { date },
      entries: [entries.get(date) ?? { date, revision: null, timeZone: null, record: null }] }
  }
  const client = { read: vi.fn(read), dispose: vi.fn() }, invalidated = vi.fn()
  const workspace = new PersonalJournalWorkspace({ session: structuredClone(session), client, invalidated, now: () => now })
  return { session, zone, now, entries, receipts, envelope, read, client, invalidated, workspace }
}
async function draft(fixture: ReturnType<typeof setup>) {
  await fixture.workspace.open('2026-11-10')
  fixture.workspace.edit({ restfulness: 4, comfort: 'comfortable', notes: 'A private synthetic note.' })
}
const writes = (fixture: ReturnType<typeof setup>) => fixture.client.read.mock.calls.filter(([, method]) => method === 'POST')

it('opens explicitly, requires personal ratings and leaves unreported habits unknown', async () => {
  const fixture = setup()
  expect(fixture.client.read).not.toHaveBeenCalled()
  await fixture.workspace.open()
  expect(fixture.workspace.getSnapshot().draft).toMatchObject({ restfulness: null, comfort: null, context: {
    habits: { caffeine: { status: 'not_logged' }, alcohol: { status: 'not_logged' }, exercise: { status: 'not_logged' } } } })
  await fixture.workspace.save()
  expect(writes(fixture)).toHaveLength(0)
  expect(fixture.workspace.getSnapshot().error).toContain('Choose')
  fixture.workspace.edit({ restfulness: 4, comfort: 'comfortable', notes: 'A private synthetic note.' })
  await fixture.workspace.save()
  expect(writes(fixture)).toHaveLength(1)
  expect(fixture.workspace.getSnapshot()).toMatchObject({ dirty: false, pending: null, message: 'Check-in saved privately on your Pod.' })
  expect(fixture.entries.get('2026-11-11')?.record?.fields.context?.caffeine.status).toBe('not_logged')
})

it('derives today from the controller calendar instead of the browser calendar', async () => {
  const fixture = setup()
  fixture.client.read.mockImplementation(async (path, method, body) => {
    const response = await fixture.read(path, method, body)
    return path.startsWith('me/journal?') ? { ...response as object, generatedAt: Date.parse('2026-11-11T03:00:00Z') } : response
  })
  await fixture.workspace.open()
  expect(fixture.workspace.getSnapshot().page?.entries[0].date).toBe('2026-11-10')
  expect(fixture.client.read.mock.calls.filter(([path]) => path.startsWith('me/journal?')).map(([path]) => path))
    .toEqual(['me/journal?date=2026-11-11', 'me/journal?date=2026-11-10'])
})

it('reconciles a committed save with a lost response without sending it again', async () => {
  const fixture = setup()
  await draft(fixture)
  fixture.client.read.mockImplementation(async (path, method, body) => {
    const response = await fixture.read(path, method, body)
    if (method === 'POST') throw new PersonalWebError('uncertain', 'Private server text')
    return response
  })
  await fixture.workspace.save()
  expect(fixture.workspace.getSnapshot().pending).not.toBeNull()
  expect(fixture.workspace.getSnapshot().draft?.notes).toBe('A private synthetic note.')
  expect(fixture.workspace.getSnapshot().error).not.toContain('Private server text')
  await fixture.workspace.save()
  expect(writes(fixture)).toHaveLength(1)
  await fixture.workspace.reconcile()
  expect(writes(fixture)).toHaveLength(1)
  expect(fixture.workspace.getSnapshot()).toMatchObject({ pending: null, dirty: false, error: null })
})

it('keeps an unknown result uncertain and does not treat a missing receipt as a failed save', async () => {
  const fixture = setup()
  await draft(fixture)
  fixture.client.read.mockImplementation((path, method, body) => method === 'POST'
    ? Promise.reject(new Error('network failed'))
    : fixture.read(path, method, body))
  await fixture.workspace.save()
  await fixture.workspace.reconcile()
  expect(fixture.workspace.getSnapshot().error).toContain('Nothing was resent')
  expect(fixture.workspace.getSnapshot().pending).not.toBeNull()
  expect(writes(fixture)).toHaveLength(1)
})

it('shows a newer saved entry instead of treating the older save receipt as current content', async () => {
  const fixture = setup()
  await draft(fixture)
  fixture.client.read.mockImplementation(async (path, method, body) => {
    const response = await fixture.read(path, method, body)
    if (method === 'POST') {
      const current = fixture.entries.get('2026-11-10')
      if (!current?.record) throw new Error('Missing synthetic saved entry')
      fixture.entries.set(current.date, { ...current, revision: '40000000-0000-4000-8000-000000000002',
        record: { ...current.record, fields: { ...current.record.fields, notes: 'Newer synthetic note.' } } })
    }
    return response
  })
  await fixture.workspace.save()
  expect(fixture.workspace.getSnapshot().draft?.notes).toBe('Newer synthetic note.')
  expect(fixture.workspace.getSnapshot().message).toContain('changed again')
})

it('clears a late committed write after the editor is hidden without replaying it', async () => {
  const fixture = setup()
  await draft(fixture)
  let resolve!: (value: unknown) => void
  fixture.client.read.mockImplementation((path, method, body) => method === 'POST'
    ? new Promise((finish) => { resolve = async () => finish(await fixture.read(path, method, body)) })
    : fixture.read(path, method, body))
  const saving = fixture.workspace.save()
  await vi.waitFor(() => expect(resolve).toBeDefined())
  fixture.workspace.clear()
  resolve(undefined)
  await saving
  expect(fixture.workspace.getSnapshot()).toMatchObject({ page: null, draft: null, pending: null, busy: false })
  expect(writes(fixture)).toHaveLength(1)
})

it('rejects a receipt from a different request while keeping the actual outcome uncertain', async () => {
  const fixture = setup()
  await draft(fixture)
  fixture.client.read.mockImplementation(async (path, method, body) => {
    const response = await fixture.read(path, method, body)
    if (method !== 'POST') return response
    const receipt = [...fixture.receipts.values()][0]
    return { ...fixture.envelope(), receipt: { ...receipt, requestId: '40000000-0000-4000-8000-000000000099' } }
  })
  await fixture.workspace.save()
  expect(fixture.workspace.getSnapshot().pending).not.toBeNull()
  expect(fixture.workspace.getSnapshot().message).toBeNull()
  expect(fixture.workspace.getSnapshot().error).toContain('not confirmed')
  expect(writes(fixture)).toHaveLength(1)
})

it('deletes with the current revision and displays current content rather than a historical receipt', async () => {
  const fixture = setup()
  await draft(fixture)
  await fixture.workspace.save()
  const revision = fixture.entries.get('2026-11-10')?.revision
  await fixture.workspace.save(true)
  expect(writes(fixture)[1][2]).toMatchObject({ expectedRevision: revision, fields: null })
  expect(fixture.workspace.getSnapshot().page?.entries[0].record).toBeNull()
  expect(fixture.workspace.getSnapshot().draft?.notes).toBe('')
  expect(fixture.workspace.getSnapshot().message).toContain('Existing backups and exports are unchanged')
})

it.each(['account', 'assignment', 'household', 'disabled'])('withdraws private text when %s changes', async (change) => {
  const fixture = setup()
  await draft(fixture)
  if (change === 'account') fixture.session.accountId = '40000000-0000-4000-8000-000000000099'
  if (change === 'assignment') fixture.session.assignmentRevision += 1
  if (change === 'household') fixture.session.householdRevision += 1
  if (change === 'disabled') fixture.session.capabilities.personalJournal = false
  await fixture.workspace.checkAccess()
  expect(fixture.workspace.getSnapshot()).toMatchObject({ page: null, draft: null, pending: null })
  if (change !== 'disabled') expect(fixture.invalidated).toHaveBeenCalledOnce()
  expect(writes(fixture)).toHaveLength(0)
})

it.each(['clear', 'dispose'] as const)('ignores a late read after %s', async (operation) => {
  const fixture = setup()
  let resolve!: (value: unknown) => void
  fixture.client.read.mockImplementation(path => path.startsWith('me/journal?')
    ? new Promise((finish) => { resolve = finish })
    : fixture.read(path))
  const opening = fixture.workspace.open('2026-11-10')
  await vi.waitFor(() => expect(resolve).toBeDefined())
  fixture.workspace[operation]()
  resolve(await fixture.read('me/journal?date=2026-11-10'))
  await opening
  expect(fixture.workspace.getSnapshot()).toMatchObject({ page: null, draft: null, busy: false })
})

it('rejects a mismatched date response and never exposes another person’s note', async () => {
  const fixture = setup()
  fixture.client.read.mockImplementation(path => fixture.read(path.startsWith('me/journal?') ? 'me/journal?date=2026-11-09' : path))
  await fixture.workspace.open('2026-11-10')
  expect(fixture.workspace.getSnapshot().page).toBeNull()
  expect(fixture.workspace.getSnapshot().error).toContain('could not be verified')
})

it('validates personal route selectors and mutation bodies before transport', () => {
  expect(personalJournalPath('me/journal?date=2026-11-10', 'GET', undefined)).toBe(true)
  for (const path of ['me/journal', 'me/journal?date=2026-11-10&side=left', 'me/journal?date=2026-11-10#x',
    'me/journal?date=2026-11-10&date=2026-11-09', 'me/journal/requests/../../owner'])
    expect(personalJournalPath(path, 'GET', undefined)).toBe(false)
  expect(personalJournalPath('me/journal', 'POST', { accountId: 'other' })).toBe(false)
  expect(personalJournalPath('me/journal?date=2026-11-10', 'PUT', undefined)).toBe(false)
})

it('compares saved personal entries without sending a draft or any mutation', async () => {
  const fixture = setup()
  await draft(fixture)
  await fixture.workspace.save()
  fixture.workspace.edit({ notes: 'An unsaved note must not enter comparisons.' })
  await fixture.workspace.loadPatterns('2026-11-01', '2026-11-10')
  expect(fixture.workspace.getSnapshot().patterns?.cohorts[0].dates).toBe(1)
  expect(JSON.stringify(fixture.workspace.getSnapshot().patterns)).not.toContain('A private synthetic note.')
  expect(JSON.stringify(fixture.workspace.getSnapshot().patterns)).not.toContain('An unsaved note')
  expect(fixture.workspace.getSnapshot().draft?.notes).toBe('An unsaved note must not enter comparisons.')
  expect(writes(fixture)).toHaveLength(1)
  expect(fixture.client.read.mock.calls.filter(([path]) => path.includes('patterns'))).toEqual([['me/journal/patterns?from=2026-11-01&through=2026-11-10']])
})

it.each(['clearPatterns', 'clear', 'dispose'] as const)('discards a late comparison when %s hides it', async (operation) => {
  const fixture = setup()
  await draft(fixture)
  let resolve!: (value: unknown) => void
  fixture.client.read.mockImplementation((path) => {
    if (path.includes('/patterns?')) {
      return new Promise((finish) => {
        resolve = finish
      })
    }
    return fixture.read(path)
  })
  const loading = fixture.workspace.loadPatterns('2026-11-01', '2026-11-10')
  await vi.waitFor(() => expect(resolve).toBeDefined())
  fixture.workspace[operation]()
  resolve(await fixture.read('me/journal/patterns?from=2026-11-01&through=2026-11-10'))
  await loading
  expect(fixture.workspace.getSnapshot()).toMatchObject({ patterns: null, patternsBusy: false })
  expect(writes(fixture)).toHaveLength(0)
})

it('withdraws comparisons when their capability is disabled while keeping the current private draft', async () => {
  const fixture = setup()
  await draft(fixture)
  await fixture.workspace.loadPatterns('2026-11-01', '2026-11-10')
  expect(fixture.workspace.getSnapshot().patterns).not.toBeNull()
  fixture.session.capabilities.personalJournalPatterns = false
  await fixture.workspace.checkAccess()
  expect(fixture.workspace.getSnapshot()).toMatchObject({ patterns: null, patternsAvailable: false, dirty: true })
  expect(fixture.workspace.getSnapshot().draft?.notes).toBe('A private synthetic note.')
  fixture.client.read.mockClear()
  await fixture.workspace.loadPatterns('2026-11-01', '2026-11-10')
  expect(fixture.client.read.mock.calls.every(([path]) => path === 'household/session')).toBe(true)
})

it('rejects mismatched comparison scope and dates without exposing their content', async () => {
  for (const mismatch of ['account', 'date']) {
    const fixture = setup()
    await draft(fixture)
    fixture.client.read.mockImplementation(async (path) => {
      const result = await fixture.read(path)
      if (!path.includes('/patterns?')) return result
      const changed = result as { scope: { accountId: string }, query: { through: string } }
      if (mismatch === 'account') changed.scope.accountId = '40000000-0000-4000-8000-000000000099'
      else changed.query.through = '2026-11-09'
      return changed
    })
    await fixture.workspace.loadPatterns('2026-11-01', '2026-11-10')
    expect(fixture.workspace.getSnapshot().patterns).toBeNull()
    if (mismatch === 'account') expect(fixture.invalidated).toHaveBeenCalledOnce()
    else expect(fixture.workspace.getSnapshot().patternsError).toContain('could not be verified')
  }
})

it('withdraws the old comparison before an uncertain save and never sends it again', async () => {
  const fixture = setup()
  await draft(fixture)
  await fixture.workspace.loadPatterns('2026-11-01', '2026-11-10')
  fixture.client.read.mockImplementation((path, method) => method === 'POST' ? Promise.reject(new Error('lost')) : fixture.read(path))
  await fixture.workspace.save()
  expect(fixture.workspace.getSnapshot()).toMatchObject({ patterns: null, patternsBusy: false })
  await fixture.workspace.loadPatterns('2026-11-01', '2026-11-10')
  expect(fixture.workspace.getSnapshot().patterns).toBeNull()
  expect(writes(fixture)).toHaveLength(1)
})

it('rejects non-range comparison routes before any transport', () => {
  const path = 'me/journal/patterns?from=2026-11-01&through=2026-11-10'
  expect(personalJournalPath(path, 'GET', undefined)).toBe(true)
  for (const suffix of ['&side=left', '&accountId=other', '&through=2026-11-11', '#fragment']) expect(personalJournalPath(path + suffix, 'GET', undefined)).toBe(false)
  expect(personalJournalPath(path, 'POST', {})).toBe(false)
})
