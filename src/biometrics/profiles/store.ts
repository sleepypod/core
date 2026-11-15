import { randomUUID } from 'node:crypto'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/schema'
import { biometricActivationEvents as events, biometricConfigOutbox as outbox, biometricProfileBindings as bindings, biometricProfileRevisions as revisions } from '@/src/db/schema'
import { stageClassifierSchema } from '@/src/lib/sleep-stage-rules'
import { biometricManifest, defaultConfig, legacyStageOverrides, manifestHash, rebaseOverrides, resolveConfig, validateConfig, type Override } from '../algorithms/registry'
import { configHash } from '../algorithms/canonical'

const sideSchema = z.enum(['left', 'right'])
const keySchema = z.string().min(1).max(200)
export const revisionInput = z.object({
  side: sideSchema,
  parentRevisionId: z.string().uuid().optional(),
  baseManifestHash: z.string().length(64).default(manifestHash),
  overrides: z.array(z.object({ path: z.string().min(1).max(200), value: z.unknown() }).strict()).max(64),
  origin: z.enum(['manual', 'migration', 'agent', 'system']),
  requester: z.string().min(1).max(200),
  idempotencyKey: keySchema,
}).strict()

type Side = z.infer<typeof sideSchema>
type ConfigDB = BetterSQLite3Database<typeof schema>
type Revision = typeof revisions.$inferSelect

/** Marks revisions this build derived from a profile pinned to another engine. */
export const REBASE_REQUESTER = 'engine-rebase'

/**
 * Configuration-only repository. No biometrics DB, numerical work or hardware
 * access is allowed here. Synchronous SQLite transactions protect revisions,
 * compare-and-swap bindings, audit events and outbox publication together.
 */
export class ProfileStore {
  constructor(private readonly db: ConfigDB, private readonly now = Date.now) {}

  createRevision(raw: z.input<typeof revisionInput>): Revision {
    const input = revisionInput.parse(raw)
    // tRPC/SuperJSON can preserve an explicitly undefined optional field.
    // Missing parent means a new family and has one canonical request identity.
    if (input.parentRevisionId === undefined) delete input.parentRevisionId
    const requestHash = configHash(input)
    return this.db.transaction((tx) => {
      const existing = tx.select().from(revisions).where(eq(revisions.idempotencyKey, input.idempotencyKey)).get()
      if (existing) {
        if (existing.requestHash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT: revision request changed')
        return existing
      }
      const parent = input.parentRevisionId
        ? tx.select().from(revisions).where(eq(revisions.id, input.parentRevisionId)).get()
        : undefined
      if (input.parentRevisionId && !parent) throw new Error('NOT_FOUND: parent revision')
      if (parent && parent.side !== input.side) throw new Error('PROFILE_INCOMPATIBLE: parent belongs to the other side')
      const familyId = parent?.familyId ?? randomUUID()
      const latest = tx.select().from(revisions).where(eq(revisions.familyId, familyId)).orderBy(desc(revisions.revision)).get()
      const resolved = resolveConfig(input.overrides, input.baseManifestHash)
      const row: typeof revisions.$inferInsert = {
        id: randomUUID(), familyId, revision: (latest?.revision ?? 0) + 1,
        side: input.side, parentRevisionId: parent?.id ?? null,
        baseManifestHash: manifestHash, baseManifest: biometricManifest,
        overrides: resolved.overrides, resolved: resolved.resolved, resolvedHash: resolved.hash,
        dependencyHashes: biometricManifest.dependencyHashes,
        origin: input.origin, requester: input.requester,
        idempotencyKey: input.idempotencyKey, requestHash, createdAtMs: this.now(),
      }
      return tx.insert(revisions).values(row).returning().get()
    }, { behavior: 'immediate' })
  }

  getRevision(id: string): Revision {
    const revision = this.db.select().from(revisions).where(eq(revisions.id, id)).get()
    if (!revision) throw new Error('NOT_FOUND: profile revision')
    return revision
  }

  listRevisions(side: Side, cursor?: { createdAtMs: number, id: string }, familyId?: string) {
    const rows = this.db.select().from(revisions).where(and(
      eq(revisions.side, side),
      familyId ? eq(revisions.familyId, familyId) : undefined,
      cursor
        ? or(lt(revisions.createdAtMs, cursor.createdAtMs),
            and(eq(revisions.createdAtMs, cursor.createdAtMs), lt(revisions.id, cursor.id)))
        : undefined,
    )).orderBy(desc(revisions.createdAtMs), desc(revisions.id)).limit(101).all()
    const items = rows.slice(0, 100)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > 100 && last ? { createdAtMs: last.createdAtMs, id: last.id } : null }
  }

  validateRevision(id: string, side: Side) {
    const revision = this.getRevision(id)
    if (revision.side !== side) throw new Error('PROFILE_INCOMPATIBLE: revision belongs to the other side')
    if (revision.baseManifestHash !== manifestHash || configHash(revision.baseManifest) !== manifestHash) {
      throw new Error('PROFILE_INCOMPATIBLE: pinned engine is not available in this build')
    }
    const resolved = validateConfig(revision.resolved)
    const rebuilt = resolveConfig(revision.overrides as Override[], revision.baseManifestHash)
    if (configHash(resolved) !== revision.resolvedHash || rebuilt.hash !== revision.resolvedHash
      || configHash(revision.dependencyHashes) !== configHash(biometricManifest.dependencyHashes)) {
      throw new Error('PROFILE_INCOMPATIBLE: immutable snapshot integrity check failed')
    }
    return { revision, resolved, hash: revision.resolvedHash }
  }

  binding(side: Side) {
    return this.db.select().from(bindings).where(eq(bindings.side, side)).get()
      ?? { side, generation: 0, desiredRevisionId: null, previousRevisionId: null, updatedAtMs: 0 }
  }

  /** Rebases always start from the authored revision, so an override a later
   * engine accepts again comes back instead of staying dropped. */
  private rebaseSource(revision: Revision) {
    return revision.origin === 'migration' && revision.requester === REBASE_REQUESTER && revision.parentRevisionId
      ? this.getRevision(revision.parentRevisionId)
      : revision
  }

  /** Paths of the authored revision that a rebased revision left out. */
  private rebaseOf(revision: Revision) {
    const source = this.rebaseSource(revision)
    if (source.id === revision.id) return null
    const kept = new Set((revision.overrides as Override[]).map(override => override.path))
    return { sourceRevisionId: source.id, droppedPaths: (source.overrides as Override[]).map(override => override.path).filter(path => !kept.has(path)) }
  }

  /**
   * Carry a revision pinned to another engine onto this build, keeping every
   * override the shipped manifest still accepts. Returns the authored revision
   * itself when it is valid here again, and null when the pinned revision is
   * current, belongs to the other side or is corrupt.
   */
  rebaseRevision(id: string, side: Side) {
    const pinned = this.getRevision(id)
    if (pinned.side !== side || pinned.baseManifestHash === manifestHash) return null
    const source = this.rebaseSource(pinned)
    if (source.side !== side) return null
    if (source.baseManifestHash === manifestHash) {
      try {
        return { revision: this.validateRevision(source.id, side).revision, sourceRevisionId: source.id, dropped: [] }
      }
      catch {
        return null
      }
    }
    const { kept, dropped } = rebaseOverrides(source.overrides as Override[])
    const revision = this.createRevision({ side, parentRevisionId: source.id, overrides: kept, origin: 'migration',
      requester: REBASE_REQUESTER, idempotencyKey: `engine-rebase:${source.id}:${manifestHash}` })
    return { revision, sourceRevisionId: source.id, dropped }
  }

  /** Desired state only. Actual runtime state must come from component receipts. */
  effective(side: Side) {
    const binding = this.binding(side)
    if (!binding.desiredRevisionId) return { binding, resolved: defaultConfig, hash: configHash(defaultConfig), isDefault: true, warning: null, rebase: null }
    try {
      const selected = this.validateRevision(binding.desiredRevisionId, side)
      return { binding, resolved: selected.resolved, hash: selected.hash, isDefault: false, warning: null, rebase: this.rebaseOf(selected.revision) }
    }
    catch (error) {
      return { binding, resolved: defaultConfig, hash: configHash(defaultConfig), isDefault: true,
        warning: error instanceof Error ? error.message : 'PROFILE_INCOMPATIBLE', rebase: null }
    }
  }

  /**
   * Legacy migration is idempotent and never overwrites an existing binding.
   * Copies all rule leaves, not only differences, so future defaults cannot
   * silently change the meaning of an old manual customization.
   */
  migrateLegacy(side: Side) {
    return this.db.transaction((tx) => {
      const existing = tx.select().from(bindings).where(eq(bindings.side, side)).get()
      if (existing) return existing
      const stored = tx.select({ classifier: schema.sideSettings.stageClassifier }).from(schema.sideSettings)
        .where(eq(schema.sideSettings.side, side)).get()?.classifier
      if (stored == null) return null // no binding means follow defaults
      const classifier = stageClassifierSchema.parse(stored)
      const revision = this.createRevision({ side, overrides: legacyStageOverrides(classifier), origin: 'migration',
        requester: 'legacy-stage-settings', idempotencyKey: `legacy-stage:${side}:${configHash(classifier)}` })
      const now = this.now()
      tx.insert(bindings).values({ side, desiredRevisionId: revision.id, generation: 1, updatedAtMs: now }).run()
      tx.insert(events).values({ id: randomUUID(), side, generation: 1, action: 'migration',
        previousHash: configHash(defaultConfig), nextHash: revision.resolvedHash,
        nextRevisionId: revision.id, evidence: { status: 'legacy_unvalidated' }, requester: 'legacy-stage-settings',
        state: 'pending_delivery', idempotencyKey: `legacy-stage:${side}`, requestHash: configHash(classifier),
        createdAtMs: now, updatedAtMs: now }).run()
      tx.insert(outbox).values({ id: randomUUID(), side, generation: 1,
        payload: { schemaVersion: 1, side, generation: 1, revisionId: revision.id, manifestHash,
          resolved: revision.resolved, resolvedHash: revision.resolvedHash, boundary: 'immediate' },
        resolvedHash: revision.resolvedHash, state: 'pending', nextAttemptAtMs: now, createdAtMs: now }).run()
      return this.binding(side)
    }, { behavior: 'immediate' })
  }
}
