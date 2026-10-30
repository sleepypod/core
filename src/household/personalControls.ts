import type Database from 'better-sqlite3'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { householdControlReceipts } from '@/src/db/schema'
import { ControlService } from '@/src/controls/service'
import { ControlConflictError, type ControlStore } from '@/src/controls/store'
import { getControlDispatchCount, withinDispatchGuard } from '@/src/controls/context'
import type { ControlAction } from '@/src/controls/contract'
import type { HouseholdCredential } from './store'
import { HouseholdError } from './store'
import { householdIdSchema, householdSideSchema } from './contract'
import { personalControlReceiptSchema, personalControlRequestSchema, personalControlScopeSchema,
  type PersonalControlRequest, type PersonalControlScope } from './controlContract'

type Side = 'left' | 'right'
type PersonalRow = typeof householdControlReceipts.$inferSelect
export interface PersonalControlPrincipal {
  accountId: string
  podId: string
  householdId: string
  sleeperId: string
}
export interface PersonalControlAuthority {
  scope: PersonalControlScope
  zones: Side[]
}
interface Dependencies {
  database: Database.Database
  runId: string
  // These callbacks must synchronously re-read current credential/assignment
  // state. No cached token claims or caller-supplied zones may grant authority.
  authenticate: (credential: HouseholdCredential) => PersonalControlPrincipal
  authorize: (credential: HouseholdCredential) => PersonalControlAuthority
  execute: (action: ControlAction) => Promise<unknown>
  now?: () => number
  monotonicNow?: () => number
}
const authoritySchema = z.object({ scope: personalControlScopeSchema,
  zones: z.array(householdSideSchema).min(1).max(2).refine(zones => new Set(zones).size === zones.length),
}).strict()

/** A scoped durable boundary; the reviewed assignment coordinator supplies authority. */
export class PersonalControlService {
  private readonly database: ReturnType<typeof drizzle>
  private readonly active = new Map<string, ControlService>()

  constructor(private readonly dependencies: Dependencies) {
    this.database = drizzle(dependencies.database)
  }

  private row(requestId: string) {
    return this.database.select().from(householdControlReceipts)
      .where(eq(householdControlReceipts.requestId, requestId)).get()
  }

  private durable<Result>(operation: () => Result): Result {
    const database = this.dependencies.database
    if (database.inTransaction) throw new Error('Personal control needs an independent durable transaction')
    const previous = database.pragma('synchronous', { simple: true }) as number
    database.pragma('synchronous = FULL')
    try {
      return database.transaction(operation).immediate()
    }
    finally { database.pragma(`synchronous = ${previous}`) }
  }

  private owned(row: PersonalRow, principal: PersonalControlPrincipal): PersonalControlRequest {
    const request = personalControlRequestSchema.parse(JSON.parse(row.personalRequest))
    if (row.accountId !== principal.accountId || request.scope.podId !== principal.podId
      || request.scope.householdId !== principal.householdId || request.scope.sleeperId !== principal.sleeperId) {
      throw new HouseholdError('forbidden', 403, 'This command is unavailable to your account.')
    }
    return request
  }

  /** Shared lifecycle, isolated storage: a legacy owner receipt lookup sees none of these rows. */
  private store(principal: PersonalControlPrincipal, personalRequest: string, zones: Side[]): ControlStore {
    const existingOwned = (requestId: string) => {
      const row = this.row(requestId)
      if (row) this.owned(row, principal)
      return row
    }
    const executing = (requestId: string, runId: string) => and(
      eq(householdControlReceipts.requestId, requestId), eq(householdControlReceipts.accountId, principal.accountId),
      eq(householdControlReceipts.runId, runId), eq(householdControlReceipts.state, 'executing'))
    return {
      get: existingOwned,
      claim: row => this.durable(() => {
        const existing = existingOwned(row.requestId)
        if (existing) {
          if (existing.personalRequest !== personalRequest || existing.fingerprint !== row.fingerprint)
            throw new ControlConflictError('The request ID belongs to a different personal command')
          return { created: false, row: existing }
        }
        this.database.insert(householdControlReceipts).values({ ...row, accountId: principal.accountId,
          personalRequest, resolvedZones: JSON.stringify(zones) }).run()
        return { created: true, row }
      }),
      dispatch: (requestId, runId, at) => this.durable(() => {
        const result = this.database.update(householdControlReceipts).set({
          dispatchCount: sql`${householdControlReceipts.dispatchCount} + 1`, lastDispatchAt: at,
        }).where(executing(requestId, runId)).run()
        if (result.changes !== 1) throw new Error('Personal dispatch receipt was not committed')
      }),
      finish: (requestId, runId, state, reason, at) => this.durable(() => {
        const row = this.database.update(householdControlReceipts).set({ state, reason, finishedAt: at })
          .where(executing(requestId, runId)).returning().get()
        if (!row) throw new Error('Personal completion receipt was not committed')
        return row
      }),
    }
  }

  private resolvedAction(request: PersonalControlRequest, side: Side): ControlAction {
    const action = request.action
    switch (action.kind) {
      case 'temperature': return { kind: action.kind, side, temperature: action.temperatureF, holdMinutes: action.holdMinutes }
      case 'power': return { kind: action.kind, side, powered: action.powered,
        ...(action.temperatureF === undefined ? {} : { temperature: action.temperatureF }) }
      case 'vibration.clear': return { kind: action.kind, side }
    }
  }

  private controller(principal: PersonalControlPrincipal, request: PersonalControlRequest, zones: Side[],
    execute: (action: ControlAction) => Promise<unknown>) {
    return new ControlService({ store: this.store(principal, JSON.stringify(request), zones),
      runId: this.dependencies.runId, now: this.dependencies.now, monotonicNow: this.dependencies.monotonicNow, execute })
  }

  private receipt(row: PersonalRow, principal: PersonalControlPrincipal) {
    const request = this.owned(row, principal)
    const zones = authoritySchema.shape.zones.parse(JSON.parse(row.resolvedZones))
    const controller = this.active.get(row.requestId)
      ?? this.controller(principal, request, zones, async () => { throw new Error('Receipt reads cannot execute') })
    const receipt = controller.get(row.requestId)
    if (!receipt) throw new Error('Personal receipt disappeared')
    return personalControlReceiptSchema.parse({ ...receipt, scope: request.scope,
      action: request.action, resolvedZones: zones })
  }

  get(credential: HouseholdCredential, requestId: string) {
    householdIdSchema.parse(requestId)
    const principal = this.dependencies.authenticate(credential)
    const row = this.row(requestId)
    if (!row || row.accountId !== principal.accountId) return null
    return this.receipt(row, principal)
  }

  async submit(credential: HouseholdCredential, input: unknown, assertRequestCurrent: () => void = () => {}) {
    assertRequestCurrent()
    const request = personalControlRequestSchema.parse(input)
    const principal = this.dependencies.authenticate(credential)
    const serialized = JSON.stringify(request)
    const existing = this.row(request.requestId)
    if (existing) {
      this.owned(existing, principal)
      if (existing.personalRequest !== serialized)
        throw new ControlConflictError('The request ID belongs to a different personal command')
      // Recover the historical receipt even after the person has moved sides.
      // A stale request can be inspected, but never applied to the new assignment.
      return this.receipt(existing, principal)
    }
    const authority = authoritySchema.parse(this.dependencies.authorize(credential))
    if (principal.podId !== authority.scope.podId || principal.householdId !== authority.scope.householdId
      || principal.sleeperId !== authority.scope.sleeperId || JSON.stringify(request.scope) !== JSON.stringify(authority.scope)) {
      throw new HouseholdError('conflict', 409, 'Your account or bed configuration changed. Reload before controlling the bed.')
    }
    const fingerprint = JSON.stringify(authority)
    const assertCurrent = () => {
      // A valid device key does not imply that the browser still has that
      // account selected. HTTP callers recheck the persisted browser binding.
      assertRequestCurrent()
      const current = this.dependencies.authenticate(credential)
      if (current.accountId !== principal.accountId || current.podId !== principal.podId
        || current.householdId !== principal.householdId || current.sleeperId !== principal.sleeperId
        || JSON.stringify(authoritySchema.parse(this.dependencies.authorize(credential))) !== fingerprint) {
        throw new HouseholdError('conflict', 409, 'Your account or bed configuration changed before dispatch.')
      }
    }
    const controller = this.controller(principal, request, authority.zones, () => withinDispatchGuard(assertCurrent, async () => {
      let skippedZone = false
      for (const side of authority.zones) {
        assertCurrent()
        const before = getControlDispatchCount()
        await this.dependencies.execute(this.resolvedAction(request, side))
        skippedZone ||= getControlDispatchCount() === before
      }
      // Debouncing may resolve a superseded command without a write. A write
      // to one zone must never count as acknowledgment of the entire bed.
      if (skippedZone && getControlDispatchCount() > 0) throw new Error('Incomplete personal command')
    }))
    this.active.set(request.requestId, controller)
    try {
      await controller.submit({ requestId: request.requestId, issuedAt: request.issuedAt, expiresAt: request.expiresAt,
        action: this.resolvedAction(request, authority.zones[0]) })
      // Re-authenticate after asynchronous work: never return a private response
      // to a device that was revoked while its command waited in the transport.
      assertRequestCurrent()
      const current = this.dependencies.authenticate(credential)
      const row = this.row(request.requestId)
      if (!row) throw new Error('Personal receipt unavailable')
      return this.receipt(row, current)
    }
    finally { this.active.delete(request.requestId) }
  }
}
