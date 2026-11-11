import type { HouseholdSession } from '../contract'
import { learningArchivePageSchema, learningRecordPageSchema, learningRecordDetailSchema,
  type LearningArchivePage, type LearningRecordPage, type LearningRecordDetail } from '../learningApiContract'
import type { PersonalWebTransport } from './client'
import { samePersonSession, PersonalWebError } from './protocol'

type Archive = LearningArchivePage['archives'][number]
type Scope = LearningArchivePage['scope']
const sessionScope = (session: HouseholdSession): Scope => ({ podId: session.podId, householdId: session.householdId,
  accountId: session.accountId, sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
  assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision })
const sameScope = (first: Scope, second: Scope) => Object.entries(first).every(([key, value]) => second[key as keyof Scope] === value)
export interface PersonalLearningState {
  available: boolean
  busy: boolean
  error: string | null
  archives: LearningArchivePage | null
  selected: Archive | null
  records: LearningRecordPage | null
  detail: LearningRecordDetail | null
}

/** One page and one selected record stay in memory; account and visibility changes discard both. */
export class PersonalLearningWorkspace {
  private generation = 0
  private disposed = false
  private checking = false
  private listeners = new Set<() => void>()
  private state: PersonalLearningState
  constructor(private readonly dependencies: { session: HouseholdSession, client: PersonalWebTransport, invalidated: () => void }) {
    this.state = { available: dependencies.session.capabilities.personalLearningArchive === true,
      busy: false, error: null, archives: null, selected: null, records: null, detail: null }
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<PersonalLearningState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }

  private current(generation: number) {
    if (this.disposed || this.generation !== generation) throw new PersonalWebError('superseded', 'A newer library request replaced this one.')
  }

  clear() {
    this.generation += 1
    this.update({ archives: null, selected: null, records: null, detail: null, busy: false, error: null })
  }

  private fail(error: unknown, generation: number) {
    if (this.disposed || generation !== this.generation) return
    this.clear()
    const code = error instanceof PersonalWebError ? error.code : null
    this.update({ error: code === 'disabled' ? null : 'Your saved learning could not be verified. Reload the library to try again.' })
    if (code === 'authentication' || code === 'account_changed') {
      this.dispose()
      this.dependencies.invalidated()
    }
  }

  private async session(generation: number) {
    const session = samePersonSession(await this.dependencies.client.read('household/session'), this.dependencies.session)
    this.current(generation)
    const available = session.capabilities.personalLearningArchive === true
    this.update({ available })
    if (!available) throw new PersonalWebError('disabled', 'Saved learning is not available on this Pod yet.')
    return session
  }

  private async read<T extends { scope: Scope }>(path: string, parse: (value: unknown) => T, generation: number): Promise<T> {
    const before = await this.session(generation)
    const result = parse(await this.dependencies.client.read(path))
    this.current(generation)
    const after = await this.session(generation)
    if (!sameScope(sessionScope(before), sessionScope(after)) || !sameScope(result.scope, sessionScope(after)))
      throw new PersonalWebError('account_changed', 'Saved learning belongs to a different account context.')
    return result
  }

  private async perform(operation: (generation: number) => Promise<void>) {
    if (this.disposed || this.state.busy) return
    const generation = ++this.generation
    this.update({ busy: true, detail: null, error: null })
    try {
      await operation(generation)
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  async load() {
    if (this.disposed) return
    this.clear()
    await this.readArchives(null)
  }

  async olderArchives() {
    if (!this.state.archives?.nextCursor) return
    await this.readArchives(this.state.archives)
  }

  private async readArchives(previous: LearningArchivePage | null) {
    await this.perform(async (generation) => {
      const before = previous?.nextCursor ?? null
      const query = new URLSearchParams({ limit: '20', ...(before ? { before } : {}) })
      const page = await this.read(`me/learning/archives?${query}`, learningArchivePageSchema.parse, generation)
      const last = previous?.archives.at(-1), first = page.archives[0]
      if (page.query.limit !== 20 || page.query.before !== before || (previous && !sameScope(previous.scope, page.scope))
        || (last && first && (first.capturedAt > last.capturedAt || (first.capturedAt === last.capturedAt && first.archiveId >= last.archiveId))))
        throw new PersonalWebError('conflict', 'The saved library page changed.')
      this.update({ archives: page, selected: null, records: null })
    })
  }

  async openArchive(archiveId: string) {
    const archive = this.state.archives?.archives.find(value => value.archiveId === archiveId)
    if (!archive) return
    await this.readRecords(archive, 0)
  }

  async olderRecords() {
    const { selected, records } = this.state
    if (!selected || !records?.nextOrdinal) return
    await this.readRecords(selected, records.nextOrdinal)
  }

  private async readRecords(archive: Archive, after: number) {
    await this.perform(async (generation) => {
      this.update({ selected: archive, records: null })
      const query = new URLSearchParams({ archiveId: archive.archiveId, after: String(after), limit: '20' })
      const page = await this.read(`me/learning/records?${query}`, learningRecordPageSchema.parse, generation)
      if (page.archiveId !== archive.archiveId || page.contentHash !== archive.contentHash || page.query.after !== after
        || page.query.limit !== 20 || !this.state.archives || !sameScope(this.state.archives.scope, page.scope))
        throw new PersonalWebError('conflict', 'Saved learning changed before it could be displayed.')
      this.update({ selected: archive, records: page })
    })
  }

  async openRecord(recordId: string) {
    const { selected, records } = this.state
    const record = records?.records.find(value => value.recordId === recordId)
    if (!selected || !records || !record) return
    await this.perform(async (generation) => {
      const detail = await this.read(`me/learning/records/${recordId}`, learningRecordDetailSchema.parse, generation)
      if (detail.archiveId !== selected.archiveId || detail.recordId !== recordId || !sameScope(records.scope, detail.scope)
        || (['sourceTable', 'sourceSide', 'kind', 'redacted'] as const).some(key => detail[key] !== record[key]))
        throw new PersonalWebError('conflict', 'The selected learning record changed.')
      this.update({ detail })
    })
  }

  closeRecord() {
    this.generation += 1
    this.update({ detail: null, busy: false, error: null })
  }

  async checkAccess() {
    if (this.disposed || this.checking || this.state.busy || !this.state.archives) return
    const generation = this.generation
    this.checking = true
    try {
      const session = await this.session(generation)
      if (this.state.archives && !sameScope(this.state.archives.scope, sessionScope(session)))
        throw new PersonalWebError('account_changed', 'The library account changed.')
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
