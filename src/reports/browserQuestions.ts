import { z } from 'zod'
import { readReportCopy, sameReportScope } from './browserContract'
import type { ReportBrowserAccess, ReportBrowserTransport } from './browserWorkspace'
import { BrowserModelFailure, browserModelChoice, browserReportModel, reportModelDestination, reportQuestionPrompt,
  type BrowserModelChoice, type BrowserModelGenerate } from './browserModel'
import { parseMorningReport, type SavedMorningReport } from './morning'

type Copy = ReturnType<typeof readReportCopy>
type Answer = NonNullable<SavedMorningReport['followUps']>[number]
interface Anchor { access: ReportBrowserAccess, copy: Copy & { report: SavedMorningReport } }
export interface ReportQuestionReview {
  id: string
  choice: BrowserModelChoice
  destination: string
  question: string
  reportDate: number
  source: string
  facts: SavedMorningReport['facts']
  expiresAt: number
}
export interface ReportQuestionState {
  phase: 'idle' | 'checking' | 'review' | 'generating' | 'answer' | 'saving' | 'uncertain' | 'recovering' | 'saved' | 'error'
  review: ReportQuestionReview | null
  answer: Answer | null
  message: string | null
}
const empty = (): ReportQuestionState => ({ phase: 'idle', review: null, answer: null, message: null })
const sameAccess = (first: ReportBrowserAccess, second: ReportBrowserAccess) => first.revision === second.revision && sameReportScope(first.scope, second.scope)

/** One reviewed request and one separately approved save; keys and unsaved answers live only in memory. */
export class MorningReportQuestions {
  private state = empty()
  private listeners = new Set<() => void>()
  private anchor: Anchor | null = null
  private key = ''
  private generation = 0
  private controller: AbortController | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly transport: ReportBrowserTransport,
    private readonly accepted: (copy: Copy) => void = () => {},
    private readonly generate: BrowserModelGenerate = browserReportModel(),
    private readonly now = Date.now, private readonly secure = () => globalThis.isSecureContext === true) {}

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(next: Partial<ReportQuestionState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...next }
    this.listeners.forEach(listener => listener())
  }

  private interrupt() {
    ++this.generation
    this.controller?.abort()
    this.controller = null
    this.key = ''
    if (this.expiry !== null) clearTimeout(this.expiry)
    this.expiry = null
  }

  bind(access: ReportBrowserAccess, copy: Copy) {
    this.clear()
    if (!copy.report || copy.receipt.deleted) return
    this.anchor = structuredClone({ access, copy: { ...copy, report: copy.report } })
  }

  clear() {
    this.interrupt()
    this.anchor = null
    this.update(empty())
  }

  dispose() {
    this.clear()
    this.disposed = true
    this.listeners.clear()
  }

  cancel() {
    // A dispatched save may have succeeded. Preserve its read-recovery requirement.
    const uncertain = ['saving', 'uncertain', 'recovering'].includes(this.state.phase)
    this.interrupt()
    this.update(uncertain
      ? { phase: 'uncertain', review: null, message: 'Saving was interrupted. Check the saved result before another upload.' }
      : { ...empty(), message: 'Request cancelled. A provider request already sent may still be billed.' })
  }

  private async verify(anchor: Anchor, signal: AbortSignal, current: () => void, requireRevision = true): Promise<Copy> {
    const before = await this.transport.access(signal)
    current()
    if (!sameAccess(before, anchor.access)) throw new Error('Account changed.')
    const copy = readReportCopy(await this.transport.read(anchor.copy.report.id, signal), before.scope, anchor.copy.report.id, this.now())
    current()
    if (!copy.report || copy.receipt.deleted || (requireRevision && copy.receipt.revision !== anchor.copy.receipt.revision)) throw new Error('Report changed.')
    const after = await this.transport.access(signal)
    current()
    if (!sameAccess(after, anchor.access)) throw new Error('Account changed.')
    return copy
  }

  private operation(duration: number) {
    const controller = new AbortController(), generation = ++this.generation
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), duration)
    const current = () => {
      if (this.disposed || generation !== this.generation || controller.signal.aborted) throw new Error('Request interrupted.')
    }
    return { signal: controller.signal, generation, current, finish: () => {
      clearTimeout(timeout)
      if (this.controller === controller) this.controller = null
    } }
  }

  private invalidate(message: string) {
    this.clear()
    this.update({ phase: 'error', message })
  }

  async prepare(input: BrowserModelChoice, question: string, key: string) {
    if (this.disposed || this.controller || ['uncertain', 'saving'].includes(this.state.phase)) return
    this.interrupt()
    const anchor = this.anchor
    if (!anchor) return
    this.update({ ...empty(), phase: 'checking' })
    const operation = this.operation(30000)
    try {
      if (!this.secure()) throw new Error('Secure connection required.')
      const choice = browserModelChoice.parse(input), destination = reportModelDestination(choice)
      const normalizedQuestion = z.string().trim().min(1).max(600).parse(question)
      const normalizedKey = choice.provider === 'ollama' ? '' : z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/).parse(key)
      if (choice.provider === 'ollama' && key.trim()) throw new Error('Cloud key cannot be sent to local model.')
      if (!anchor.copy.report.facts.length || (anchor.copy.report.followUps?.length ?? 0) >= 10) throw new Error('Report cannot accept another question.')
      await this.verify(anchor, operation.signal, operation.current)
      operation.current()
      this.key = normalizedKey
      const review: ReportQuestionReview = { id: crypto.randomUUID(), choice, destination, question: normalizedQuestion,
        reportDate: anchor.copy.report.createdAt, source: anchor.copy.report.source,
        facts: structuredClone(anchor.copy.report.facts), expiresAt: this.now() + 5 * 60000 }
      this.update({ phase: 'review', review })
      this.expiry = setTimeout(() => {
        if (this.state.review?.id === review.id && this.state.phase === 'review') {
          this.interrupt()
          this.update({ ...empty(), message: 'This review expired. Review your question again before sending.' })
        }
      }, 5 * 60000)
    }
    catch {
      if (operation.generation === this.generation)
        this.invalidate('The question could not be prepared. Refresh this report and check your secure connection, model settings and question.')
    }
    finally { operation.finish() }
  }

  async send(reviewId: string, consent: boolean) {
    const anchor = this.anchor, review = this.state.review
    if (this.disposed || this.controller || this.state.phase !== 'review' || !anchor || !review || !consent || review.id !== reviewId) return
    if (review.expiresAt <= this.now() || !this.secure()) {
      this.cancel()
      this.update({ message: 'This review expired or its secure connection changed. Review again before sending.' })
      return
    }
    const key = this.key
    this.interrupt()
    const operation = this.operation(120000)
    this.update({ phase: 'generating', review: null, answer: null, message: null })
    let dispatched = false
    try {
      await this.verify(anchor, operation.signal, operation.current)
      operation.current()
      if (!this.secure() || review.expiresAt <= this.now()) throw new Error('Review expired.')
      dispatched = true
      const result = await this.generate({ choice: review.choice, key, prompt: reportQuestionPrompt(anchor.copy.report, review.question) }, operation.signal)
      operation.current()
      await this.verify(anchor, operation.signal, operation.current)
      operation.current()
      const answer: Answer = { id: crypto.randomUUID(), createdAt: this.now(), question: review.question, text: result.text,
        provider: review.choice.provider, model: review.choice.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens }
      parseMorningReport(JSON.stringify({ version: 1, report: { ...anchor.copy.report, followUps: [...(anchor.copy.report.followUps ?? []), answer] } }), this.now())
      this.update({ phase: 'answer', answer, message: 'Answer ready. It has not been saved to your Pod.' })
    }
    catch (error) {
      if (operation.generation === this.generation)
        this.invalidate(error instanceof BrowserModelFailure
          ? `${error.message} Refresh this report to review a new request. Nothing was saved or will retry automatically; an attempted request may still be billed.`
          : dispatched
            ? 'No answer could be verified. The provider may have charged for the request. Refresh and review again; nothing will retry automatically.'
            : 'Your account or report could not be verified before sending. Refresh the report and review again.')
    }
    finally { operation.finish() }
  }

  async save(consent: boolean) {
    const anchor = this.anchor, answer = this.state.answer
    if (this.disposed || this.controller || this.state.phase !== 'answer' || !anchor || !answer || !consent || !this.transport.write) return
    const operation = this.operation(30000)
    this.update({ phase: 'saving', message: null })
    let dispatched = false
    try {
      await this.verify(anchor, operation.signal, operation.current)
      operation.current()
      const report = parseMorningReport(JSON.stringify({ version: 1, report: { ...anchor.copy.report,
        followUps: [...(anchor.copy.report.followUps ?? []), answer] } }), this.now())
      dispatched = true
      const result = await this.transport.write(report.id, anchor.copy.receipt.revision, report, operation.signal)
      operation.current()
      readReportCopy(result, anchor.access.scope, report.id, this.now())
      const copy = await this.verify(anchor, operation.signal, operation.current, false)
      this.accept(copy, anchor, answer)
    }
    catch {
      if (operation.generation === this.generation) {
        if (dispatched) this.update({ phase: 'uncertain', message: 'The saved result is unconfirmed. Check it before another upload; nothing will be resent.' })
        else this.invalidate('Your account or report changed before saving. Refresh the report before continuing.')
      }
    }
    finally { operation.finish() }
  }

  async recover() {
    const anchor = this.anchor, answer = this.state.answer
    if (this.disposed || this.controller || this.state.phase !== 'uncertain' || !anchor || !answer) return
    const operation = this.operation(30000)
    this.update({ phase: 'recovering', message: null })
    try {
      const copy = await this.verify(anchor, operation.signal, operation.current, false)
      if (copy.report?.followUps?.some(item => item.id === answer.id)) this.accept(copy, anchor, answer)
      else if (copy.receipt.revision === anchor.copy.receipt.revision)
        this.update({ phase: 'answer', message: 'The current web copy has no new answer. You can review and save it again.' })
      else this.invalidate('The shared report changed. Refresh it before continuing; your upload was not repeated.')
    }
    catch {
      if (operation.generation === this.generation)
        this.invalidate('The saved result could not be verified. Reconnect this account and refresh the report library. Nothing was resent.')
    }
    finally { operation.finish() }
  }

  private accept(copy: Copy, anchor: Anchor, answer: Answer) {
    const saved = copy.report?.followUps?.find(item => item.id === answer.id)
    if (!copy.report || !saved || JSON.stringify(saved) !== JSON.stringify(answer)) throw new Error('Answer was not saved.')
    const original = (report: SavedMorningReport) => {
      const copy = { ...report }
      delete copy.followUps
      return copy
    }
    if (JSON.stringify(original(copy.report)) !== JSON.stringify(original(anchor.copy.report))) throw new Error('Original evidence changed.')
    this.anchor = structuredClone({ access: anchor.access, copy: { ...copy, report: copy.report } })
    this.update({ phase: 'saved', message: 'Answer saved with this report on your Pod.' })
    this.accepted(copy)
  }
}
