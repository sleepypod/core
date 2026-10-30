import { createHash } from 'node:crypto'
import { controlRequestSchema, type ControlAction, type ControlReceipt } from './contract'
import { withinControlRequest, type ControlDispatchScope } from './context'
import type { ControlRow, ControlStore } from './store'

interface Options {
  store: ControlStore
  execute: (action: ControlAction) => Promise<unknown>
  runId: string
  now?: () => number
  monotonicNow?: () => number
}

/** One claim per ID. An interrupted operation is observable but is never resumed. */
export class ControlService {
  private readonly active = new Set<string>()
  private readonly now: () => number
  private readonly monotonicNow: () => number

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
  }

  private receipt(row: ControlRow): ControlReceipt {
    const request = controlRequestSchema.parse(JSON.parse(row.request))
    const orphaned = row.state === 'executing' && (row.runId !== this.options.runId || !this.active.has(row.requestId))
    return {
      version: 1, requestId: row.requestId, action: request.action,
      issuedAt: request.issuedAt, expiresAt: request.expiresAt, receivedAt: row.receivedAt,
      finishedAt: row.finishedAt, lastDispatchAt: row.lastDispatchAt,
      state: orphaned ? 'unknown' : row.state,
      reason: orphaned ? 'execution_interrupted' : row.reason,
      dispatchCount: row.dispatchCount,
      physicalVerification: 'unverified', replayAllowed: false,
    }
  }

  get(requestId: string): ControlReceipt | null {
    const row = this.options.store.get(requestId)
    return row ? this.receipt(row) : null
  }

  async submit(input: unknown): Promise<ControlReceipt> {
    const request = controlRequestSchema.parse(input)
    const serialized = JSON.stringify(request)
    const receivedAt = this.now()
    const remaining = request.expiresAt - receivedAt
    const monotonicDeadline = this.monotonicNow() + Math.max(0, remaining)
    const state = request.issuedAt > receivedAt ? 'rejected' : remaining <= 0 ? 'expired' : 'executing'
    const { created, row } = this.options.store.claim({
      requestId: request.requestId, request: serialized,
      fingerprint: createHash('sha256').update(serialized).digest('hex'),
      state, reason: state === 'rejected' ? 'issued_in_future' : state === 'expired' ? 'request_expired' : null,
      receivedAt, finishedAt: state === 'executing' ? null : receivedAt,
      dispatchCount: 0, lastDispatchAt: null, runId: this.options.runId,
    })
    if (!created || state !== 'executing') return this.receipt(row)

    this.active.add(request.requestId)
    const scope: ControlDispatchScope = {
      issuedAt: request.issuedAt, expiresAt: request.expiresAt, monotonicDeadline,
      now: this.now, monotonicNow: this.monotonicNow,
      beforeDispatch: at => this.options.store.dispatch(request.requestId, this.options.runId, at),
      dispatchCount: 0, deadlineRejected: false, closed: false,
    }
    let succeeded = false
    try {
      try {
        await withinControlRequest(scope, () => this.options.execute(request.action))
        succeeded = true
      }
      catch {
        // Never expose raw hardware/DB messages or infer failure after a write.
      }
      const dispatched = scope.dispatchCount > 0
      const terminal = succeeded
        ? (dispatched ? 'acknowledged' : 'not_dispatched')
        : dispatched ? 'unknown' : scope.deadlineRejected ? 'expired' : 'rejected'
      const reason = terminal === 'acknowledged'
        ? null
        : terminal === 'unknown'
          ? 'dispatch_outcome_unknown'
          : terminal === 'expired' ? 'request_expired' : terminal === 'not_dispatched' ? 'no_hardware_write' : 'control_not_dispatched'
      const completed = this.options.store.finish(request.requestId, this.options.runId, terminal, reason, this.now())
      return this.receipt(completed)
    }
    finally {
      this.active.delete(request.requestId)
    }
  }
}
