import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/schema'
import { configHash } from '../algorithms/canonical'
import { manifestHash, validateConfig } from '../algorithms/registry'
import { ProfileStore } from './store'
import { runtimePayloadSchema } from './runtime'

/** Publish a new immutable generation when the shipped engine changes or a
 * projection is unavailable. The desired pinned revision and rollback target
 * survive fallback. This records intent, never processor adoption. */
export function recoverRuntimeIntent(db: BetterSQLite3Database<typeof schema>, side: 'left' | 'right', now = Date.now()) {
  return db.transaction((tx) => {
    const binding = tx.select().from(schema.biometricProfileBindings).where(eq(schema.biometricProfileBindings.side, side)).get()
    if (!binding) return null // An unpersonalized side follows the daemon's shipped default.
    const profiles = new ProfileStore(db, () => now)
    // A deploy that changes the engine rebases the pinned profile instead of
    // dropping the side to defaults. The rollback target is left as it was.
    const rebase = binding.desiredRevisionId ? profiles.rebaseRevision(binding.desiredRevisionId, side) : null
    if (rebase) tx.update(schema.biometricProfileBindings).set({ desiredRevisionId: rebase.revision.id })
      .where(and(eq(schema.biometricProfileBindings.side, side), eq(schema.biometricProfileBindings.generation, binding.generation))).run()
    const desired = profiles.effective(side)
    const actualRevisionId = desired.warning ? null : desired.binding.desiredRevisionId
    const previous = tx.select().from(schema.biometricConfigOutbox).where(and(eq(schema.biometricConfigOutbox.side, side),
      eq(schema.biometricConfigOutbox.generation, binding.generation))).get()
    const decoded = runtimePayloadSchema.safeParse(previous?.payload)
    let matching = false
    if (previous && decoded.success) {
      const payload = decoded.data
      try {
        matching = previous.state !== 'failed' && payload.side === side && payload.generation === binding.generation
          && payload.resolvedHash === previous.resolvedHash && payload.manifestHash === manifestHash
          && payload.revisionId === actualRevisionId && payload.resolvedHash === desired.hash
          && configHash(validateConfig(payload.resolved)) === desired.hash
      }
      catch { /* A corrupt immutable projection requires a new audited generation. */ }
    }
    if (matching) return null

    const defaultUpdate = binding.desiredRevisionId === null && decoded.success && decoded.data.manifestHash !== manifestHash
    const restoringProfile = binding.desiredRevisionId !== null && decoded.success && decoded.data.revisionId === null
    const status = desired.warning
      ? 'profile_incompatible'
      : rebase ? 'profile_rebased' : defaultUpdate ? 'system_default_update' : restoringProfile ? 'profile_restored' : 'runtime_repair'
    const droppedPaths = rebase?.dropped.map(override => override.path) ?? []
    const warning = desired.warning ?? (droppedPaths.length ? `PROFILE_REBASED: dropped overrides this build rejects: ${droppedPaths.join(', ')}` : null)
    const reason = status === 'profile_incompatible'
      ? 'Pinned profile is unavailable in this build; using shipped defaults'
      : status === 'profile_rebased'
        ? droppedPaths.length
          ? `Pinned profile rebased onto this build without ${droppedPaths.join(', ')}`
          : 'Pinned profile rebased onto this build with every override kept'
        : status === 'system_default_update'
          ? 'Refresh shipped system defaults'
          : status === 'profile_restored'
            ? 'Pinned profile is compatible again; restore at the next session'
            : 'Repair missing or incompatible runtime intent'
    // The runtime has no valid profile for this engine, so apply the closest
    // one now rather than spending the rest of the session on defaults.
    const boundary = status === 'profile_rebased'
      ? 'immediate'
      : status === 'profile_restored'
        ? 'next_session'
        : status === 'runtime_repair'
          ? decoded.success ? decoded.data.boundary : binding.desiredRevisionId ? 'next_session' : 'immediate'
          : 'immediate'
    const generation = binding.generation + 1
    const key = `runtime-recovery:${side}:${generation}:${manifestHash}`
    const evidence = { status, requestedRevisionId: binding.desiredRevisionId, actualRevisionId,
      manifestHash, resolvedHash: desired.hash, warning,
      ...(rebase ? { rebasedFromRevisionId: rebase.sourceRevisionId, droppedOverrides: rebase.dropped } : {}) }
    tx.update(schema.biometricProfileBindings).set({ generation, updatedAtMs: now })
      .where(and(eq(schema.biometricProfileBindings.side, side), eq(schema.biometricProfileBindings.generation, binding.generation))).run()
    // Prevent an undelivered obsolete payload from racing the recovery payload.
    if (previous?.state === 'pending') tx.update(schema.biometricConfigOutbox).set({ state: 'failed', lastError: 'Superseded by runtime recovery' })
      .where(eq(schema.biometricConfigOutbox.id, previous.id)).run()
    const event = tx.insert(schema.biometricActivationEvents).values({ id: randomUUID(), side, generation, action: 'fallback',
      previousRevisionId: binding.desiredRevisionId, nextRevisionId: actualRevisionId,
      previousHash: previous?.resolvedHash ?? desired.hash, nextHash: desired.hash, evidence,
      requester: 'runtime-coordinator', state: 'pending_delivery', reason,
      idempotencyKey: key, requestHash: configHash(evidence), createdAtMs: now, updatedAtMs: now }).returning().get()
    tx.insert(schema.biometricConfigOutbox).values({ id: randomUUID(), side, generation,
      resolvedHash: desired.hash, payload: { schemaVersion: 1, side, generation, revisionId: actualRevisionId,
        manifestHash, resolved: desired.resolved, resolvedHash: desired.hash, boundary },
      state: 'pending', nextAttemptAtMs: now, createdAtMs: now }).run()
    return event
  }, { behavior: 'immediate' })
}
