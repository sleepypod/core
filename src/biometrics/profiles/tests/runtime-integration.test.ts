// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it, vi } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { tickBiometricRuntime } from '../runtime-host'
import { consumeStageView } from '../stage-view'
const holder = vi.hoisted(() => ({ config: null as unknown, bio: null as unknown }))
vi.mock('@/src/db', () => ({
  get db() { return holder.config },
  get biometricsDb() { return holder.bio },
}))
const { biometricTuningRouter } = await import('@/src/server/routers/biometricTuning')
const caller = biometricTuningRouter.createCaller({})

// No daemon main loop, sensor transport, hardware or user databases. This runs
// the shipped live adapter and estimator against one bounded synthetic frame.
function frame(path: string, occupied: boolean) {
  const output = execFileSync(resolve('modules/piezo-processor/.venv/bin/python'), ['-c', `
import json, sqlite3, sys
sys.path.insert(0, 'modules')
sys.path.insert(0, 'modules/piezo-processor')
import numpy as np
from main import DBHolder, SideProcessor
from runtime_adapter import RuntimeCoordinator
connection = sqlite3.connect(sys.argv[1])
holder = DBHolder(connection)
processors = {side: SideProcessor(side, holder) for side in ('left', 'right')}
runtime = RuntimeCoordinator(holder, processors)
runtime.before_frame(None, lambda side: sys.argv[2] == 'true', 1791673200000)
for processor in processors.values():
    processor.ingest(np.zeros(500))
runtime.after_frame(1791673200000)
print(json.dumps({'enabled': runtime.enabled, 'problem': runtime.problem,
                  'leftTolerance': processors['left'].parameters.tracking_tolerance_bpm,
                  'rightTolerance': processors['right'].parameters.tracking_tolerance_bpm}))
connection.close()
`, path, String(occupied)], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 })
  return JSON.parse(output) as { enabled: boolean, problem: string | null, leftTolerance: number, rightTolerance: number }
}

// Needs the locked piezo-processor venv, which Stryker's sandbox doesn't carry.
it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('acknowledges exact API intent through Python and stage consumers, restart, and rollback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'biometric-runtime-integration-'))
  const configRaw = new Database(join(directory, 'config.db'))
  const bioPath = join(directory, 'biometrics.db')
  const bioRaw = new Database(bioPath)
  try {
    const config = drizzle(configRaw, { schema: configSchema })
    const bio = drizzle(bioRaw, { schema: bioSchema })
    migrate(config, { migrationsFolder: 'src/db/migrations' })
    migrate(bio, { migrationsFolder: 'src/db/biometrics-migrations' })
    holder.config = config
    holder.bio = bio
    const defaults = await caller.resolveProfile({ overrides: [] })
    const revision = await caller.createProfileRevision({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }],
      origin: 'manual', requester: 'integration', idempotencyKey: 'candidate' })
    const event = await caller.activateProfile({ side: 'left', revisionId: revision.id, expectedGeneration: 0,
      expectedResolvedHash: revision.resolvedHash, boundary: 'next_session', requester: 'integration', idempotencyKey: 'activate', allowUnvalidated: true })
    tickBiometricRuntime(config, bio)
    expect(frame(bioPath, true)).toMatchObject({ enabled: true, problem: null, leftTolerance: 15 })
    expect(await caller.getActivationStatus({ side: 'left', id: event.id })).toMatchObject({ observedState: 'pending_boundary', receipts: [] })
    expect(frame(bioPath, false)).toMatchObject({ problem: null, leftTolerance: 20, rightTolerance: 15 })
    expect(await caller.getActivationStatus({ side: 'left', id: event.id })).toMatchObject({ observedState: 'pending_boundary' })
    expect(consumeStageView(config, bio, 'left').provenance.bundleHash).toBe(revision.resolvedHash)
    expect(await caller.getActivationStatus({ side: 'left', id: event.id })).toMatchObject({ observedState: 'applied', receipts: expect.arrayContaining([
      expect.objectContaining({ component: 'sleep_stages', appliedHash: revision.resolvedHash }),
    ]) })
    // Status polling cannot turn a mismatched receipt into an acknowledgment.
    bioRaw.prepare('UPDATE biometric_runtime_receipts SET applied_hash = \'wrong\' WHERE component = \'heart_rate\'').run()
    const changes = bioRaw.prepare('SELECT total_changes() AS count').get()
    expect(await caller.getActivationStatus({ side: 'left', id: event.id })).toMatchObject({ observedState: 'pending_boundary' })
    expect(bioRaw.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
    bioRaw.prepare('UPDATE biometric_runtime_receipts SET applied_hash = ? WHERE component = \'heart_rate\'').run(revision.resolvedHash)
    // New Python process restores the acknowledged profile despite an occupied bed.
    expect(frame(bioPath, true).leftTolerance).toBe(20)
    const rollback = await caller.rollbackProfile({ side: 'left', revisionId: null, expectedGeneration: 1,
      expectedResolvedHash: defaults.hash, boundary: 'immediate', requester: 'integration', idempotencyKey: 'rollback', allowUnvalidated: true })
    tickBiometricRuntime(config, bio)
    expect(frame(bioPath, true).leftTolerance).toBe(15)
    consumeStageView(config, bio, 'left')
    expect(await caller.getActivationStatus({ side: 'left', id: rollback.id })).toMatchObject({ observedState: 'applied', isCurrent: true })
    expect(await caller.getActivationStatus({ side: 'left', id: event.id })).toMatchObject({ isCurrent: false })
    expect(bioRaw.prepare('SELECT count(*) AS count FROM vitals').get()).toEqual({ count: 0 })
  }
  finally {
    configRaw.close()
    bioRaw.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)
