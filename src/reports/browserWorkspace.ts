import { readReportCopy, readReportLibrary, sameReportScope, type ReportBrowserScope, type ReportMetadata } from './browserContract'
import { reportIdSchema, type SavedMorningReport } from './morning'
import { MorningReportQuestions } from './browserQuestions'

export interface ReportBrowserAccess { scope: ReportBrowserScope, revision: string }
export interface ReportBrowserTransport {
  access(signal: AbortSignal): Promise<ReportBrowserAccess>
  read(id: string | null, signal: AbortSignal): Promise<unknown>
  write?(id: string, revision: string, report: SavedMorningReport, signal: AbortSignal): Promise<unknown>
}
export interface ReportLibraryState {
  reports: ReportMetadata[] | null
  report: SavedMorningReport | null
  selectedId: string | null
  checkedAt: number | null
  busy: boolean
  error: string | null
  withdrawn: boolean
}
const empty = (): ReportLibraryState => ({ reports: null, report: null, selectedId: null, checkedAt: null, busy: false, error: null, withdrawn: false })

/** In-memory library. Explicit questions and saves share its account and visibility lifetime. */
export class MorningReportBrowserWorkspace {
  readonly questions: MorningReportQuestions
  private state = empty()
  private listeners = new Set<() => void>()
  private generation = 0
  private controller: AbortController | null = null
  private anchor: ReportBrowserAccess | null = null
  private disposed = false
  constructor(private readonly transport: ReportBrowserTransport, private readonly now = Date.now) {
    this.questions = new MorningReportQuestions(transport, (copy) => {
      if (!this.anchor || !sameReportScope(copy.scope, this.anchor.scope) || copy.receipt.id !== this.state.selectedId || !copy.report) return
      this.update({ report: copy.report, checkedAt: this.now(), reports: this.state.reports?.map(item => item.id === copy.receipt.id
        ? { ...item, ...copy.receipt }
        : item) ?? null })
    }, undefined, now)
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(next: Partial<ReportLibraryState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...next }
    this.listeners.forEach(listener => listener())
  }

  clear() {
    ++this.generation
    this.controller?.abort()
    this.controller = null
    this.questions.clear()
    this.update(empty())
  }

  dispose() {
    this.clear()
    this.questions.dispose()
    this.disposed = true
    this.listeners.clear()
  }

  async open(selectedId: string | null = null) {
    if (this.disposed) return
    this.clear()
    const generation = this.generation, controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 30000)
    this.update({ busy: true })
    const current = () => {
      if (this.disposed || generation !== this.generation || controller.signal.aborted) throw new Error('Report read was interrupted.')
    }
    try {
      if (selectedId !== null) reportIdSchema.parse(selectedId)
      const before = await this.transport.access(controller.signal)
      current()
      if (this.anchor && !sameAccess(before, this.anchor)) throw new Error('Report account changed.')
      this.anchor ??= before
      const library = readReportLibrary(await this.transport.read(null, controller.signal), before.scope, this.now())
      current()
      const selected = selectedId ?? library.reports[0]?.id ?? null
      const copy = selected === null ? null : readReportCopy(await this.transport.read(selected, controller.signal), before.scope, selected, this.now())
      current()
      const after = await this.transport.access(controller.signal)
      current()
      if (!sameAccess(before, after)) throw new Error('Report account changed.')
      // A changed revision between metadata and content is safe to read only after refreshing the list.
      const listed = library.reports.find(report => report.id === selected)
      if (copy && !copy.receipt.deleted && (!listed || copy.receipt.revision !== listed.revision)) throw new Error('Report changed during loading.')
      if (copy) this.questions.bind(after, copy)
      this.update({ reports: library.reports, selectedId: selected, report: copy?.report ?? null,
        withdrawn: copy?.receipt.deleted ?? false, checkedAt: this.now(), busy: false })
    }
    catch {
      if (!this.disposed && generation === this.generation)
        this.update({ ...empty(), error: 'Your shared reports could not be verified. Check your connection and account, then refresh.' })
    }
    finally {
      clearTimeout(timeout)
      if (generation === this.generation) this.controller = null
    }
  }

  async checkAccess() {
    if (this.disposed || this.state.busy || this.controller || this.state.reports === null || this.questions.getSnapshot().phase === 'saving') return
    const generation = this.generation, controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const access = await this.transport.access(controller.signal)
      if (this.disposed || generation !== this.generation) return
      if (!this.anchor || !sameAccess(access, this.anchor)) throw new Error('Report account changed.')
      if (this.state.selectedId) {
        const copy = readReportCopy(await this.transport.read(this.state.selectedId, controller.signal), access.scope, this.state.selectedId, this.now())
        if (this.disposed || generation !== this.generation) return
        const listed = this.state.reports?.find(report => report.id === this.state.selectedId)
        if (copy.receipt.deleted || listed?.revision !== copy.receipt.revision) throw new Error('Report was withdrawn or changed.')
      }
      const after = await this.transport.access(controller.signal)
      if (this.disposed || generation !== this.generation) return
      if (controller.signal.aborted || !sameAccess(access, after)) throw new Error('Report access changed during checking.')
    }
    catch {
      if (!this.disposed && generation === this.generation) {
        this.clear()
        this.update({ error: 'This report’s access or saved version changed. Refresh to read the current library.' })
      }
    }
    finally {
      clearTimeout(timeout)
      if (generation === this.generation) this.controller = null
    }
  }
}
const sameAccess = (first: ReportBrowserAccess, second: ReportBrowserAccess) => first.revision === second.revision && sameReportScope(first.scope, second.scope)
