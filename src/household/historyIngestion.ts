import { z } from 'zod'
import { householdIdSchema } from './contract'
import type { PresenceHistoryImporter } from './presenceHistoryImporter'

export const historyIngestionTargetSchema = z.object({
  householdId: householdIdSchema, datasetId: householdIdSchema, reviewReceiptId: householdIdSchema,
}).strict()
type Target = z.infer<typeof historyIngestionTargetSchema>
type Scan = PresenceHistoryImporter['scan']
type Cursor = NonNullable<ReturnType<Scan>['nextCursor']>
export interface HistoryIngestionStatus {
  state: 'stopped' | 'waiting' | 'disabled' | 'awaiting_review' | 'ready' | 'unavailable'
  lastAttemptAt: number | null
  lastSuccessfulPageAt: number | null
  lastCompleteAuditAt: number | null
  consecutiveFailures: number
}
interface Dependencies {
  enabled: () => boolean
  target: () => Target | null
  scan: Scan
  now?: () => number
}
const PAGE_SIZE = 25
const POLL_MS = 30_000
const AUDIT_MS = 15 * 60_000
const MAX_RETRY_MS = 15 * 60_000

/** Two bounded lanes: new arrivals stay responsive while older copies are
 * revalidated. Restart replays from zero; neither cursor grants ownership. */
export class PersonalHistoryIngestion {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private readonly now: () => number
  private targetKey: string | null = null
  private tailCursor: Cursor | null = null
  private tailWatermark = 0
  private auditCursor: Cursor | null = null
  private auditDueAt: number | null = null
  private current: HistoryIngestionStatus = { state: 'stopped', lastAttemptAt: null,
    lastSuccessfulPageAt: null, lastCompleteAuditAt: null, consecutiveFailures: 0 }

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now
  }

  status(): HistoryIngestionStatus { return { ...this.current } }

  start(): void {
    if (this.running) return
    this.running = true
    this.current.state = 'waiting'
    this.schedule(5_000)
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.resetProgress()
    this.current.state = 'stopped'
  }

  private resetProgress(): void {
    this.targetKey = null
    this.tailCursor = null
    this.tailWatermark = 0
    this.auditCursor = null
    this.auditDueAt = null
    this.current.lastSuccessfulPageAt = null
    this.current.lastCompleteAuditAt = null
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.running) return
      this.tick()
      if (this.running) this.schedule(Math.min(MAX_RETRY_MS,
        POLL_MS * 2 ** Math.min(this.current.consecutiveFailures, 5)))
    }, delay)
    this.timer.unref()
  }

  private page(target: Target, continuation: { cursor: Cursor } | { afterId: number }) {
    const result = this.dependencies.scan({ householdId: target.householdId,
      datasetId: target.datasetId, ...continuation, limit: PAGE_SIZE })
    this.current.lastSuccessfulPageAt = this.now()
    return result
  }

  /** Synchronous SQLite pages cannot overlap a timer tick or shutdown. Failed
   * pages retain their cursor, including interruptions after individual commits. */
  private tick(): void {
    this.current.lastAttemptAt = this.now()
    try {
      if (!this.dependencies.enabled()) {
        this.resetProgress()
        this.current.state = 'disabled'
        this.current.consecutiveFailures = 0
        return
      }
      const candidate = this.dependencies.target()
      if (candidate === null) {
        this.resetProgress()
        this.current.state = 'awaiting_review'
        this.current.consecutiveFailures = 0
        return
      }
      const target = historyIngestionTargetSchema.parse(candidate)
      const key = JSON.stringify(target)
      if (this.targetKey !== key) {
        this.resetProgress()
        this.targetKey = key
      }
      const tail = this.page(target, this.tailCursor ? { cursor: this.tailCursor } : { afterId: this.tailWatermark })
      this.tailCursor = tail.nextCursor
      if (tail.nextCursor === null) {
        this.tailWatermark = tail.watermark
        // The first catch-up also audited all older rows. Later audits have
        // their own fixed watermark so ongoing arrivals cannot starve them.
        if (this.auditDueAt === null) {
          this.current.lastCompleteAuditAt = this.now()
          this.auditDueAt = this.now() + AUDIT_MS
        }
      }
      if (this.auditDueAt !== null && (this.auditCursor !== null || this.now() >= this.auditDueAt)) {
        const audit = this.page(target, this.auditCursor ? { cursor: this.auditCursor } : { afterId: 0 })
        this.auditCursor = audit.nextCursor
        if (audit.nextCursor === null) {
          this.current.lastCompleteAuditAt = this.now()
          this.auditDueAt = this.now() + AUDIT_MS
        }
      }
      this.current.state = 'ready'
      this.current.consecutiveFailures = 0
    }
    catch {
      // Errors may contain SQL, private recording data or paths. Expose only
      // a bounded retry state; do not log them or reset the reviewed binding.
      this.current.state = 'unavailable'
      this.current.consecutiveFailures = Math.min(this.current.consecutiveFailures + 1, 32)
    }
  }
}
