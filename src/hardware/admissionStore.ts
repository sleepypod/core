import type Database from 'better-sqlite3'
import { z } from 'zod'
import { HardwareAdmissionError, type HardwareAdmissionSnapshot } from './admission'

const identity = z.uuid()
const rowSchema = z.object({
  id: z.literal(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hold_id: identity.nullable(), held_at: z.number().int().positive().max(8_640_000_000_000_000).nullable(),
}).strict().refine(row => (row.hold_id === null) === (row.held_at === null))

/** Durable singleton seeded only by migration. Missing/corrupt state is never silently repaired. */
export class HardwareAdmissionStore {
  constructor(private readonly database: Database.Database, private readonly now = Date.now) {}

  read(): HardwareAdmissionSnapshot {
    const rows = this.database.prepare('SELECT * FROM hardware_admission').all()
    if (rows.length !== 1) throw new HardwareAdmissionError()
    const parsed = rowSchema.safeParse(rows[0])
    if (!parsed.success) throw new HardwareAdmissionError()
    return { revision: parsed.data.revision, holdId: parsed.data.hold_id }
  }

  private durable<Result>(operation: () => Result): Result {
    if (this.database.inTransaction) throw new Error('Admission changes need an independent durable transaction')
    const previous = this.database.pragma('synchronous', { simple: true }) as number
    this.database.pragma('synchronous = FULL')
    try {
      return this.database.transaction(operation).immediate()
    }
    finally { this.database.pragma(`synchronous = ${previous}`) }
  }

  /** Exact replay retains the revision. Another coordinator cannot take over an unresolved hold. */
  hold(operationId: string): HardwareAdmissionSnapshot {
    return this.holdWithReceipt(operationId, () => undefined).admission
  }

  /** Persist the caller's receipt in the same commit as admission closes. Callbacks must be synchronous. */
  holdWithReceipt<Result>(operationId: string, operation: (admission: HardwareAdmissionSnapshot, created: boolean) => Result) {
    identity.parse(operationId)
    return this.durable(() => {
      const current = this.read()
      if (current.holdId !== operationId) {
        if (current.holdId !== null || current.revision >= Number.MAX_SAFE_INTEGER) throw new HardwareAdmissionError()
        const heldAt = z.number().int().positive().max(8_640_000_000_000_000).parse(this.now())
        this.database.prepare('UPDATE hardware_admission SET revision = ?, hold_id = ?, held_at = ? WHERE id = 1')
          .run(current.revision + 1, operationId, heldAt)
      }
      return this.performWhileHeld(operationId, this.read().revision, admission => operation(admission, current.holdId !== operationId))
    })
  }

  /** Commit configuration and its receipt while preserving the exact unresolved hold. */
  transactionWhileHeld<Result>(operationId: string, expectedRevision: number, operation: (admission: HardwareAdmissionSnapshot) => Result) {
    identity.parse(operationId)
    return this.durable(() => this.performWhileHeld(operationId, expectedRevision, operation))
  }

  private performWhileHeld<Result>(operationId: string, expectedRevision: number, operation: (admission: HardwareAdmissionSnapshot) => Result) {
    const admission = this.read()
    if (admission.holdId !== operationId || admission.revision !== expectedRevision) throw new HardwareAdmissionError()
    const result = operation({ ...admission })
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Admission receipt callbacks must be synchronous')
    const after = this.read()
    if (after.holdId !== operationId || after.revision !== expectedRevision) throw new HardwareAdmissionError()
    return { admission, result }
  }

  /** Internal recovery primitive, not an endpoint. A coordinator must reconcile its receipt before release. */
  release(operationId: string, expectedRevision: number): HardwareAdmissionSnapshot {
    identity.parse(operationId)
    return this.durable(() => {
      const current = this.read()
      if (current.holdId !== operationId || current.revision !== expectedRevision || current.revision >= Number.MAX_SAFE_INTEGER)
        throw new HardwareAdmissionError()
      this.database.prepare('UPDATE hardware_admission SET revision = ?, hold_id = NULL, held_at = NULL WHERE id = 1')
        .run(current.revision + 1)
      return this.read()
    })
  }
}
