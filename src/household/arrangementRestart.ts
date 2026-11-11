import type Database from 'better-sqlite3'
import { z } from 'zod'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { controllerGenerationSchema, type ControllerGeneration } from '@/src/server/controllerGeneration'
import { arrangementDigest } from './arrangementTransitionState'
import { arrangementTransitionContextSchema, readArrangementTransition, rejectArrangementTransition, type ArrangementTransitionRow } from './arrangementTransitionRecord'
import { arrangementRestartRequestSchema, arrangementRestartReceiptSchema,
  type ArrangementRestartRequest, type ArrangementRestartReceipt } from './arrangementRestartContract'

const rowSchema = z.object({
  operation_id: z.uuid(), request_id: z.uuid(), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request: z.string().max(8192), controller: z.string().max(2048), receipt: z.string().max(2048),
}).strict()

/** One durable dispatch intent per transition. Network retries never submit another restart. */
export class ArrangementRestartStore {
  private readonly admission: HardwareAdmissionStore
  constructor(private readonly database: Database.Database, private readonly now = Date.now) {
    this.admission = new HardwareAdmissionStore(database, now)
  }

  read(operationId: string) {
    z.uuid().parse(operationId)
    const raw = this.database.prepare('SELECT * FROM household_arrangement_restarts WHERE operation_id = ?').get(operationId)
    if (!raw) return null
    const row = rowSchema.parse(raw)
    const request = arrangementRestartRequestSchema.parse(JSON.parse(row.request))
    const receipt = arrangementRestartReceiptSchema.parse(JSON.parse(row.receipt))
    const controller = controllerGenerationSchema.parse(JSON.parse(row.controller))
    const transition = readArrangementTransition(this.database, operationId)
    if (!transition) throw rejectArrangementTransition()
    const original = arrangementTransitionContextSchema.parse(JSON.parse(transition.context)).controller
    if (row.operation_id !== operationId || request.operationId !== operationId || receipt.operationId !== operationId
      || request.requestId !== row.request_id || receipt.requestId !== row.request_id
      || arrangementDigest(request) !== row.request_hash || receipt.requestedAt < request.issuedAt || receipt.requestedAt >= request.expiresAt
      || controller.observedAt > receipt.requestedAt || receipt.requestedAt - controller.observedAt > 5000
      || arrangementDigest({ ...controller, observedAt: 0 }) !== arrangementDigest({ ...original, observedAt: 0 })) throw rejectArrangementTransition()
    return { request, receipt, controller }
  }

  prepare(row: ArrangementTransitionRow, request: ArrangementRestartRequest, controller: ControllerGeneration, assertCurrent: () => void) {
    return this.admission.transactionWhileHeld(row.id, row.admission_revision, () => {
      assertCurrent()
      if (this.read(row.id) !== null) throw rejectArrangementTransition()
      const receipt = arrangementRestartReceiptSchema.parse({ operationId: row.id, requestId: request.requestId,
        state: 'requested', requestedAt: this.now(), resultAt: null, hardware: 'held_for_runtime_recovery', replayAllowed: false })
      this.database.prepare(`INSERT INTO household_arrangement_restarts
        (operation_id, request_id, request_hash, request, controller, receipt) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(row.id, request.requestId, arrangementDigest(request), JSON.stringify(request), JSON.stringify(controller), JSON.stringify(receipt))
      assertCurrent()
      const saved = this.read(row.id)
      if (!saved) throw rejectArrangementTransition()
      return saved.receipt
    }).result
  }

  finish(row: ArrangementTransitionRow, request: ArrangementRestartRequest, state: 'submitted' | 'unconfirmed'): ArrangementRestartReceipt {
    return this.admission.transactionWhileHeld(row.id, row.admission_revision, () => {
      const saved = this.read(row.id)
      if (!saved || arrangementDigest(saved.request) !== arrangementDigest(request) || saved.receipt.state !== 'requested') throw rejectArrangementTransition()
      const receipt = arrangementRestartReceiptSchema.parse({ ...saved.receipt, state, resultAt: this.now() })
      this.database.prepare('UPDATE household_arrangement_restarts SET receipt = ? WHERE operation_id = ?')
        .run(JSON.stringify(receipt), row.id)
      return receipt
    }).result
  }
}
