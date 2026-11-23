// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { requestManualActivation } from '../activation'
import { recoverRuntimeIntent } from '../recovery'
import { ProfileStore } from '../store'
import { deliverRuntimeOutbox, reconcileActivation, RUNTIME_COMPONENTS } from '../runtime'
import { tickBiometricRuntime } from '../runtime-host'
import { resolveStageView } from '../stage-view'
let configRaw: Database.Database, bioRaw: Database.Database
let config: ReturnType<typeof drizzle<typeof configSchema>>, bio: ReturnType<typeof drizzle<typeof bioSchema>>
const now = 1791673200000
beforeEach(() => {
  configRaw = new Database(':memory:')
  bioRaw = new Database(':memory:')
  config = drizzle(configRaw, { schema: configSchema })
  bio = drizzle(bioRaw, { schema: bioSchema })
  migrate(config, { migrationsFolder: 'src/db/migrations' })
  migrate(bio, { migrationsFolder: 'src/db/biometrics-migrations' })
})
afterEach(() => {
  configRaw.close()
  bioRaw.close()
})
function activate(custom = false) {
  const revision = custom
    ? new ProfileStore(config).createRevision({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }],
        origin: 'manual', requester: 'fixture', idempotencyKey: 'profile' })
    : null
  requestManualActivation(config, { side: 'left', action: revision ? 'activate' : 'reset', revisionId: revision?.id ?? null, expectedGeneration: 0,
    expectedResolvedHash: revision?.resolvedHash ?? configHash(defaultConfig), boundary: 'next_session', requester: 'fixture', idempotencyKey: 'activate', allowUnvalidated: true }, now)
  return revision
}
function obsoleteProjection() {
  const row = config.select().from(configSchema.biometricConfigOutbox).get()
  if (!row) throw new Error('Missing projection')
  configRaw.prepare('UPDATE biometric_config_outbox SET payload = ?').run(JSON.stringify({ ...row.payload as object, manifestHash: 'previous-build' }))
}
describe('runtime recovery across builds', () => {
  it('keeps implicit defaults implicit and does not supersede valid next-session intent', () => {
    expect(recoverRuntimeIntent(config, 'left', now)).toBeNull()
    activate()
    expect(recoverRuntimeIntent(config, 'left', now)).toBeNull()
    expect(new ProfileStore(config).binding('left').generation).toBe(1)
  })
  it('refreshes an obsolete shipped default once and preserves its audit explanation after acknowledgment', () => {
    activate()
    obsoleteProjection()
    const event = recoverRuntimeIntent(config, 'left', now)
    expect(event?.evidence).toMatchObject({ status: 'system_default_update', manifestHash })
    expect(event?.generation).toBe(2)
    expect(recoverRuntimeIntent(config, 'left', now)).toBeNull()
    deliverRuntimeOutbox(config, bio, now)
    for (const component of RUNTIME_COMPONENTS) bio.insert(bioSchema.biometricRuntimeReceipts).values({ side: 'left', component, generation: 2,
      appliedHash: configHash(defaultConfig), state: 'applied', effectiveSampleTimeMs: now, heartbeatAtMs: now }).run()
    expect(reconcileActivation(config, bio, 'left', now)?.state).toBe('applied')
    expect(config.select().from(configSchema.biometricActivationEvents).all().find(row => row.generation === 2)?.reason).toContain('Refresh shipped')
  })
  it('preserves pinned intent and rollback history during fallback, including after biometric reset', () => {
    const revision = activate(true)
    if (!revision) throw new Error('Missing revision')
    configRaw.prepare('UPDATE biometric_profile_revisions SET resolved_hash = ? WHERE id = ?').run('corrupt', revision.id)
    expect(tickBiometricRuntime(config, bio, now).errors).toEqual([])
    const binding = new ProfileStore(config).binding('left')
    expect(binding).toMatchObject({ desiredRevisionId: revision.id, previousRevisionId: null, generation: 2 })
    const projection = bio.select().from(bioSchema.biometricRuntimeConfigs).get()
    expect(projection?.payload).toMatchObject({ revisionId: null, resolvedHash: configHash(defaultConfig) })
    expect(config.select().from(configSchema.biometricActivationEvents).all().find(row => row.generation === 2)?.evidence).toMatchObject({ status: 'profile_incompatible', requestedRevisionId: revision.id })
    bio.delete(bioSchema.biometricRuntimeConfigs).run()
    tickBiometricRuntime(config, bio, now)
    expect(new ProfileStore(config).binding('left').generation).toBe(2)
    expect(bio.select().from(bioSchema.biometricRuntimeConfigs).get()?.generation).toBe(2)
    for (const component of RUNTIME_COMPONENTS.slice(0, 3)) bio.insert(bioSchema.biometricRuntimeReceipts).values({ side: 'left', component, generation: 2,
      appliedHash: configHash(defaultConfig), state: 'applied', effectiveSampleTimeMs: now, heartbeatAtMs: now }).run()
    expect(resolveStageView(config, bio, 'left').provenance.warning).toContain('PROFILE_INCOMPATIBLE')
    expect(config.select().from(configSchema.biometricProfileRevisions).get()?.id).toBe(revision.id)
  })
  it('restores a compatible-again pinned revision at the next session, never silently rewriting old snapshots', () => {
    const revision = activate(true)
    if (!revision) throw new Error('Missing revision')
    configRaw.prepare('UPDATE biometric_profile_revisions SET resolved_hash = ?').run('corrupt')
    recoverRuntimeIntent(config, 'left', now)
    configRaw.prepare('UPDATE biometric_profile_revisions SET resolved_hash = ?').run(revision.resolvedHash)
    const restored = recoverRuntimeIntent(config, 'left', now)
    expect(restored?.evidence).toMatchObject({ status: 'profile_restored', actualRevisionId: revision.id })
    expect(config.select().from(configSchema.biometricConfigOutbox).all().find(row => row.generation === 3)?.payload)
      .toMatchObject({ boundary: 'next_session', resolvedHash: revision.resolvedHash })
    expect(new ProfileStore(config).binding('left').desiredRevisionId).toBe(revision.id)
  })
  it('repairs a missing custom intent conservatively at the next session', () => {
    activate(true)
    config.delete(configSchema.biometricConfigOutbox).run()
    const event = recoverRuntimeIntent(config, 'left', now)
    expect(event?.evidence).toMatchObject({ status: 'runtime_repair' })
    expect(config.select().from(configSchema.biometricConfigOutbox).get()?.payload).toMatchObject({ boundary: 'next_session' })
  })
  it('repairs conflicting biometric projections through a new generation while retaining the corrupt row for diagnosis', () => {
    activate(true)
    tickBiometricRuntime(config, bio, now)
    bioRaw.prepare('UPDATE biometric_runtime_configs SET payload = ?').run('{}')
    tickBiometricRuntime(config, bio, now + 1)
    expect(config.select().from(configSchema.biometricConfigOutbox).get()?.state).toBe('failed')
    tickBiometricRuntime(config, bio, now + 2)
    expect(new ProfileStore(config).binding('left').generation).toBe(2)
    const rows = bio.select().from(bioSchema.biometricRuntimeConfigs).all()
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.generation === 1)?.payload).toEqual({})
    expect(rows.find(row => row.generation === 2)?.payload).toMatchObject({ boundary: 'next_session' })
  })
  it('rolls back all recovery changes when outbox persistence fails', () => {
    activate()
    obsoleteProjection()
    configRaw.exec('CREATE TRIGGER reject_recovery BEFORE INSERT ON biometric_config_outbox BEGIN SELECT RAISE(ABORT, \'full\'); END;')
    expect(() => recoverRuntimeIntent(config, 'left', now)).toThrow('full')
    expect(new ProfileStore(config).binding('left').generation).toBe(1)
    expect(config.select().from(configSchema.biometricActivationEvents).all()).toHaveLength(1)
    expect(config.select().from(configSchema.biometricConfigOutbox).get()?.state).toBe('pending')
  })
})

/** A revision saved by an earlier build, with overrides that build accepted. */
function pinnedToPreviousBuild(overrides: Array<{ path: string, value: unknown }>) {
  const revision = activate(true)
  if (!revision) throw new Error('Missing revision')
  configRaw.prepare('UPDATE biometric_profile_revisions SET base_manifest_hash = ?, overrides = ? WHERE id = ?')
    .run('previous-build', JSON.stringify(overrides), revision.id)
  obsoleteProjection()
  return revision
}
function events() {
  return config.select().from(configSchema.biometricActivationEvents).all()
}
function payload(generation: number) {
  return config.select().from(configSchema.biometricConfigOutbox).all().find(row => row.generation === generation)?.payload
}
describe('rebasing a pinned profile onto a new engine', () => {
  const tolerance = { path: 'heart_rate.trackingToleranceBpm', value: 20 }
  const retired = { path: 'heart_rate.retiredKnob', value: 3 }
  const outOfRange = { path: 'breathing_rate.intervalLowerRatio', value: 5 }

  it('carries a fully compatible profile over immediately with no warning', () => {
    const original = pinnedToPreviousBuild([tolerance])
    expect(tickBiometricRuntime(config, bio, now).errors).toEqual([])
    const profiles = new ProfileStore(config)
    const binding = profiles.binding('left')
    expect(binding).toMatchObject({ generation: 2, previousRevisionId: null })
    const rebased = profiles.getRevision(binding.desiredRevisionId ?? '')
    expect(rebased).toMatchObject({ origin: 'migration', requester: 'engine-rebase', parentRevisionId: original.id, familyId: original.familyId,
      baseManifestHash: manifestHash, overrides: [tolerance], resolvedHash: original.resolvedHash })
    expect(events().find(row => row.generation === 2)).toMatchObject({ action: 'fallback', previousRevisionId: original.id, nextRevisionId: rebased.id,
      nextHash: original.resolvedHash, reason: 'Pinned profile rebased onto this build with every override kept',
      evidence: { status: 'profile_rebased', rebasedFromRevisionId: original.id, actualRevisionId: rebased.id, droppedOverrides: [], warning: null } })
    expect(payload(2)).toMatchObject({ revisionId: rebased.id, resolvedHash: original.resolvedHash, boundary: 'immediate' })
    expect(profiles.effective('left')).toMatchObject({ isDefault: false, warning: null, hash: original.resolvedHash,
      rebase: { sourceRevisionId: original.id, droppedPaths: [] } })
    tickBiometricRuntime(config, bio, now + 1)
    expect(profiles.binding('left').generation).toBe(2)
    expect(config.select().from(configSchema.biometricProfileRevisions).all()).toHaveLength(2)
  })

  it('activates the compatible subset of a partly compatible profile and names every dropped path', () => {
    const original = pinnedToPreviousBuild([tolerance, retired, outOfRange])
    const event = recoverRuntimeIntent(config, 'left', now)
    const profiles = new ProfileStore(config)
    const rebased = profiles.getRevision(profiles.binding('left').desiredRevisionId ?? '')
    expect(rebased.overrides).toEqual([tolerance])
    expect(event).toMatchObject({ nextRevisionId: rebased.id, reason: 'Pinned profile rebased onto this build without heart_rate.retiredKnob, breathing_rate.intervalLowerRatio',
      evidence: { status: 'profile_rebased', rebasedFromRevisionId: original.id,
        warning: 'PROFILE_REBASED: dropped overrides this build rejects: heart_rate.retiredKnob, breathing_rate.intervalLowerRatio',
        droppedOverrides: [{ path: retired.path, reason: 'Unknown override path: heart_rate.retiredKnob' },
          { path: outOfRange.path, reason: 'Invalid biometric parameter: breathing_rate.intervalLowerRatio' }] } })
    expect(payload(2)).toMatchObject({ revisionId: rebased.id, boundary: 'immediate', resolved: { heart_rate: { trackingToleranceBpm: 20 } } })
    expect(profiles.effective('left')).toMatchObject({ isDefault: false, warning: null,
      rebase: { sourceRevisionId: original.id, droppedPaths: [retired.path, outOfRange.path] } })
  })

  it('keeps an incompatible profile pinned, on defaults, with every path named instead of a silent fallback', () => {
    const original = pinnedToPreviousBuild([retired, outOfRange])
    const event = recoverRuntimeIntent(config, 'left', now)
    const profiles = new ProfileStore(config)
    const desired = profiles.effective('left')
    expect(desired).toMatchObject({ isDefault: false, warning: null, hash: configHash(defaultConfig),
      rebase: { sourceRevisionId: original.id, droppedPaths: [retired.path, outOfRange.path] } })
    expect(profiles.getRevision(desired.binding.desiredRevisionId ?? '').overrides).toEqual([])
    expect(event?.evidence).toMatchObject({ status: 'profile_rebased', droppedOverrides: [{ path: retired.path }, { path: outOfRange.path }] })
  })

  it('rebases again from the authored profile on the next deploy, so the warning lasts while paths stay dropped', () => {
    const original = pinnedToPreviousBuild([tolerance, retired])
    recoverRuntimeIntent(config, 'left', now)
    const first = new ProfileStore(config).binding('left').desiredRevisionId
    configRaw.prepare('UPDATE biometric_profile_revisions SET base_manifest_hash = ? WHERE id = ?').run('second-build', first)
    configRaw.prepare('UPDATE biometric_profile_revisions SET idempotency_key = ? WHERE id = ?').run('engine-rebase:earlier-build', first)
    const event = recoverRuntimeIntent(config, 'left', now + 1)
    const profiles = new ProfileStore(config)
    const second = profiles.getRevision(profiles.binding('left').desiredRevisionId ?? '')
    expect(second.id).not.toBe(first)
    expect(second.parentRevisionId).toBe(original.id)
    expect(event?.evidence).toMatchObject({ status: 'profile_rebased', requestedRevisionId: first, rebasedFromRevisionId: original.id, droppedOverrides: [{ path: retired.path }] })
    expect(profiles.effective('left').rebase).toEqual({ sourceRevisionId: original.id, droppedPaths: [retired.path] })
  })

  it('returns to the authored revision itself when an engine accepts it again', () => {
    const original = pinnedToPreviousBuild([tolerance])
    recoverRuntimeIntent(config, 'left', now)
    const rebased = new ProfileStore(config).binding('left').desiredRevisionId
    configRaw.prepare('UPDATE biometric_profile_revisions SET base_manifest_hash = ? WHERE id = ?').run('other-build', rebased)
    configRaw.prepare('UPDATE biometric_profile_revisions SET base_manifest_hash = ? WHERE id = ?').run(manifestHash, original.id)
    const event = recoverRuntimeIntent(config, 'left', now + 1)
    expect(event).toMatchObject({ previousRevisionId: rebased, nextRevisionId: original.id, evidence: { status: 'profile_rebased', droppedOverrides: [] } })
    expect(new ProfileStore(config).effective('left')).toMatchObject({ warning: null, rebase: null, binding: { desiredRevisionId: original.id } })
  })
})
