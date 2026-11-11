import type { z } from 'zod'
import type { HouseholdSession } from '../contract'
import { personalJournalReadResponseSchema, personalJournalWriteResponseSchema, type PersonalJournalReceipt } from '../personalJournalContract'
import { parsePersonalJournalPatternsQuery, personalJournalPatternsResponseSchema, type PersonalJournalPatterns } from '../personalJournalPatterns'
import type { PersonalWebTransport } from './client'
import { identifier, PersonalWebError, samePersonSession } from './protocol'
import { journalDateSchema, journalFieldsSchema, type JournalFields } from '@/src/journal/contract'
import { journalContextDraft, parseJournalContextDraft, type JournalContextDraft } from '@/src/journal/contextDraft'
import { sourceDate } from '@/src/lib/localDates'

type JournalPage = z.infer<typeof personalJournalReadResponseSchema>
type Scope = JournalPage['scope']
export interface PersonalJournalDraft {
  restfulness: number | null
  comfort: JournalFields['comfort'] | null
  notes: string
  context: JournalContextDraft
}
interface PendingCheckIn { requestId: string, date: string, timeZone: string, outcome: 'saved' | 'deleted' }
export interface PersonalJournalState {
  available: boolean
  busy: boolean
  page: JournalPage | null
  draft: PersonalJournalDraft | null
  dirty: boolean
  pending: PendingCheckIn | null
  error: string | null
  message: string | null
  patternsAvailable: boolean
  patternsBusy: boolean
  patterns: PersonalJournalPatterns | null
  patternsError: string | null
}
const scopeFor = (session: HouseholdSession): Scope => ({ podId: session.podId, householdId: session.householdId,
  accountId: session.accountId, sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
  assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision })
const sameScope = (first: Scope, second: Scope) => Object.entries(first).every(([key, value]) => second[key as keyof Scope] === value)
const blankFields: JournalFields = { restfulness: 3, comfort: 'comfortable', notes: '', caffeine: false, alcohol: false, exercise: false }

/** Private text stays only in the open workspace. Reconnect and receipt checks never replay a save. */
export class PersonalJournalWorkspace {
  private generation = 0
  private disposed = false
  private checking = false
  private patternsGeneration = 0
  private listeners = new Set<() => void>()
  private state: PersonalJournalState
  constructor(private readonly dependencies: { session: HouseholdSession, client: PersonalWebTransport, invalidated: () => void, now?: () => number }) {
    this.state = { available: dependencies.session.capabilities.personalJournal === true, busy: false, page: null,
      draft: null, dirty: false, pending: null, error: null, message: null,
      patternsAvailable: dependencies.session.capabilities.personalJournalPatterns === true, patternsBusy: false, patterns: null, patternsError: null }
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<PersonalJournalState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }

  private current(generation: number) {
    if (this.disposed || generation !== this.generation) throw new PersonalWebError('superseded', 'The check-in view changed.')
  }

  clear() {
    this.generation += 1
    this.clearPatterns()
    this.update({ page: null, draft: null, dirty: false, pending: null, busy: false, error: null, message: null })
  }

  private fail(error: unknown, generation: number) {
    if (this.disposed || generation !== this.generation) return
    const code = error instanceof PersonalWebError ? error.code : null
    if (['authentication', 'account_changed', 'disabled'].includes(code ?? '')) {
      this.clear()
      if (code !== 'disabled') {
        this.dispose()
        this.dependencies.invalidated()
      }
      return
    }
    this.update({ error: this.state.pending
      ? 'The save result is not confirmed. Check its result before making another change.'
      : 'The check-in could not be verified. Open the saved entry again to continue.' })
  }

  private async session(generation: number) {
    const session = samePersonSession(await this.dependencies.client.read('household/session'), this.dependencies.session)
    this.current(generation)
    const available = session.capabilities.personalJournal === true
    const patternsAvailable = session.capabilities.personalJournalPatterns === true
    this.update({ available, patternsAvailable })
    if (!patternsAvailable) this.clearPatterns()
    if (!available) throw new PersonalWebError('disabled', 'Personal check-ins are not enabled on this Pod yet.')
    return session
  }

  private async scoped<Result extends { scope: Scope }>(path: string, parse: (input: unknown) => Result, generation: number, needsPatterns = false) {
    const before = await this.session(generation)
    if (needsPatterns && !before.capabilities.personalJournalPatterns) throw new PersonalWebError('patterns_disabled', 'Personal comparisons are unavailable.')
    const result = parse(await this.dependencies.client.read(path))
    this.current(generation)
    const after = await this.session(generation)
    if (needsPatterns && !after.capabilities.personalJournalPatterns) throw new PersonalWebError('patterns_disabled', 'Personal comparisons are unavailable.')
    if (!sameScope(scopeFor(before), scopeFor(after)) || !sameScope(result.scope, scopeFor(after)))
      throw new PersonalWebError('account_changed', 'The check-in account changed.')
    return result
  }

  private async page(date: string, generation: number) {
    journalDateSchema.parse(date)
    const result = await this.scoped(`me/journal?date=${date}`, personalJournalReadResponseSchema.parse, generation)
    if (!('date' in result.query) || result.query.date !== date)
      throw new PersonalWebError('invalid', 'The check-in date changed.')
    return result
  }

  private show(page: JournalPage, message: string | null = null) {
    this.clearPatterns()
    const selected = page.entries[0], saved = selected.record?.fields
    this.update({ page, draft: { restfulness: saved?.restfulness ?? null, comfort: saved?.comfort ?? null,
      notes: saved?.notes ?? '', context: journalContextDraft(saved ?? blankFields, selected.timeZone ?? page.currentTimeZone) },
    dirty: false, pending: null, error: null, message })
  }

  clearPatterns() {
    this.patternsGeneration += 1
    this.update({ patterns: null, patternsBusy: false, patternsError: null })
  }

  /** Compare saved entries only; editing a draft cannot enter the source cohort. */
  async loadPatterns(from: string, through: string) {
    if (this.disposed || !this.state.page || this.state.busy || this.state.pending || this.state.patternsBusy) return
    const generation = this.generation, operation = ++this.patternsGeneration
    this.update({ patterns: null, patternsBusy: true, patternsError: null })
    try {
      const query = parsePersonalJournalPatternsQuery(new URLSearchParams({ from, through }))
      const path = `me/journal/patterns?${new URLSearchParams(query)}`
      const result = await this.scoped(path, personalJournalPatternsResponseSchema.parse, generation, true)
      this.current(generation)
      if (operation !== this.patternsGeneration) return
      if (result.query.from !== from || result.query.through !== through) throw new PersonalWebError('invalid', 'Comparison dates changed.')
      this.update({ patterns: result })
    }
    catch (error) {
      if (generation !== this.generation || operation !== this.patternsGeneration) return
      const code = error instanceof PersonalWebError ? error.code : null
      if (['authentication', 'account_changed', 'disabled'].includes(code ?? '')) this.fail(error, generation)
      else this.update({ patternsError: code === 'patterns_disabled'
        ? 'Personal comparisons are not enabled on this Pod. Your check-in is still available.'
        : 'Comparisons could not be verified. Choose a range of up to 90 dates and try again. Your draft is unchanged.' })
    }
    finally { if (generation === this.generation && operation === this.patternsGeneration) this.update({ patternsBusy: false }) }
  }

  /** Call only after the editor confirms discarding any unsaved draft or uncertain result. */
  async open(date?: string) {
    if (this.disposed || this.state.busy) return
    this.clear()
    const generation = this.generation
    this.update({ busy: true })
    try {
      let page = await this.page(date ?? new Date((this.dependencies.now ?? Date.now)()).toISOString().slice(0, 10), generation)
      const today = sourceDate(page.generatedAt / 1000, page.currentTimeZone)
      if (!date && page.entries[0].date !== today) page = await this.page(today, generation)
      this.show(page)
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  edit(patch: Partial<PersonalJournalDraft>) {
    if (!this.state.draft || this.state.busy || this.state.pending) return
    this.update({ draft: { ...this.state.draft, ...patch }, dirty: true, error: null, message: null })
  }

  validation(): { fields?: JournalFields, error?: string } {
    const { page, draft } = this.state
    if (!page || !draft) return { error: 'Open a check-in first.' }
    if (draft.restfulness === null || draft.comfort === null) return { error: 'Choose how rested and comfortable you felt.' }
    const selected = page.entries[0]
    const context = parseJournalContextDraft(draft.context, selected.date, selected.timeZone ?? page.currentTimeZone,
      (this.dependencies.now ?? Date.now)())
    if (!context.context) return { error: context.error }
    const fields = journalFieldsSchema.safeParse({ restfulness: draft.restfulness, comfort: draft.comfort, notes: draft.notes,
      context: context.context, caffeine: context.context.caffeine.status === 'yes', alcohol: context.context.alcohol.status === 'yes',
      exercise: context.context.exercise.status === 'yes' })
    return fields.success ? { fields: fields.data } : { error: 'Check your ratings and keep the note within 500 characters.' }
  }

  private validateReceipt(receipt: PersonalJournalReceipt | null, pending: PendingCheckIn) {
    if (receipt && (receipt.requestId !== pending.requestId || receipt.date !== pending.date
      || receipt.timeZone !== pending.timeZone || receipt.outcome !== pending.outcome))
      throw new PersonalWebError('invalid', 'The result does not match this check-in request.')
    return receipt
  }

  private async finish(receipt: PersonalJournalReceipt, generation: number) {
    const page = await this.page(receipt.date, generation)
    const changed = page.entries[0].revision !== receipt.revision
    this.show(page, changed
      ? 'Your change was saved, then this entry changed again. Showing the current saved entry.'
      : receipt.outcome === 'saved' ? 'Check-in saved privately on your Pod.' : 'Check-in removed. Existing backups and exports are unchanged.')
  }

  async save(remove = false) {
    const { page } = this.state
    if (this.disposed || this.state.busy || this.state.pending || !page) return
    const checked = remove ? {} : this.validation()
    if (!remove && !checked.fields) {
      this.update({ error: checked.error ?? 'Review the check-in.' })
      return
    }
    if (remove && !page.entries[0].record) return
    this.clearPatterns()
    const selected = page.entries[0], generation = ++this.generation
    const pending: PendingCheckIn = { requestId: identifier(), date: selected.date,
      timeZone: selected.timeZone ?? page.currentTimeZone, outcome: remove ? 'deleted' : 'saved' }
    this.update({ busy: true, error: null, message: null })
    try {
      const session = await this.session(generation)
      if (!sameScope(page.scope, scopeFor(session))) throw new PersonalWebError('account_changed', 'The check-in context changed.')
      this.update({ pending })
      const result = personalJournalWriteResponseSchema.parse(await this.dependencies.client.read('me/journal', 'POST', {
        requestId: pending.requestId, expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision,
        date: selected.date, expectedRevision: selected.revision, expectedTimeZone: pending.timeZone, fields: remove ? null : checked.fields,
      }))
      this.current(generation)
      const after = await this.session(generation)
      if (!sameScope(result.scope, scopeFor(after)) || !sameScope(scopeFor(session), scopeFor(after)))
        throw new PersonalWebError('account_changed', 'The check-in account changed before confirmation.')
      const receipt = this.validateReceipt(result.receipt, pending)
      if (!receipt) throw new PersonalWebError('uncertain', 'The save receipt is unavailable.')
      await this.finish(receipt, generation)
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  async reconcile() {
    const { pending } = this.state
    if (!pending || this.disposed || this.state.busy) return
    const generation = ++this.generation
    this.update({ busy: true, error: null, message: null })
    try {
      const result = await this.scoped(`me/journal/requests/${pending.requestId}`, personalJournalWriteResponseSchema.parse, generation)
      const receipt = this.validateReceipt(result.receipt, pending)
      if (receipt) await this.finish(receipt, generation)
      else this.update({ error: 'No saved result is available yet. Nothing was resent. Check again, or reopen the current entry before deciding what to do.' })
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  async checkAccess() {
    if (!this.state.page || this.disposed || this.checking || this.state.busy) return
    const generation = this.generation
    this.checking = true
    try {
      const session = await this.session(generation)
      if (this.state.page && !sameScope(this.state.page.scope, scopeFor(session)))
        throw new PersonalWebError('account_changed', 'The personal context changed.')
    }
    catch (error) { this.fail(error, generation) }
    finally { this.checking = false }
  }

  dispose() {
    if (this.disposed) return
    this.clear()
    this.disposed = true
    this.dependencies.client.dispose()
    this.listeners.clear()
  }
}
