import { z } from 'zod'
import { stageViewSchema } from './stage-view'
import { runtimeHealthSchema } from './health'
import { stageClassifierSchema } from '@/src/lib/sleep-stage-rules'
import { biometricManifest, validateConfig, type BiometricConfig } from '../algorithms/registry'

// The canonical manifest remains the source of parameter bounds. The typed
// adapter supplies UI inference while the shared validator checks interactions.
export const biometricConfigSchema = (z.fromJSONSchema(biometricManifest.parameters as unknown as z.core.JSONSchema.JSONSchema) as z.ZodType<BiometricConfig>)
  .superRefine((value, context) => {
    try {
      validateConfig(value)
    }
    catch {
      context.addIssue({ code: 'custom', message: 'Invalid biometric parameter relationship' })
    }
  })
export const overrideSchema = z.object({ path: z.string(), value: z.unknown() })
export const revisionSchema = z.object({
  id: z.string().uuid(), familyId: z.string().uuid(), revision: z.number().int(), side: z.enum(['left', 'right']),
  baseManifestHash: z.string(), baseManifest: z.unknown(), overrides: z.array(overrideSchema),
  resolved: z.unknown(), resolvedHash: z.string(), dependencyHashes: z.record(z.string(), z.string()),
  parentRevisionId: z.string().uuid().nullable(), origin: z.enum(['manual', 'migration', 'agent', 'system']),
  requester: z.string(), idempotencyKey: z.string(), requestHash: z.string(), createdAtMs: z.number(),
})
export const bindingSchema = z.object({ side: z.enum(['left', 'right']), generation: z.number().int(),
  desiredRevisionId: z.string().uuid().nullable(), previousRevisionId: z.string().uuid().nullable(), updatedAtMs: z.number() })
export const profileOverviewSchema = z.object({
  stageView: stageViewSchema,
  desired: z.object({ binding: bindingSchema, resolved: biometricConfigSchema, hash: z.string(), isDefault: z.boolean(), warning: z.string().nullable(),
    rebase: z.object({ sourceRevisionId: z.string().uuid(), droppedPaths: z.array(z.string()) }).nullable() }),
  legacyStageView: z.object({ classifier: stageClassifierSchema, personalized: z.boolean(), migrationPending: z.boolean() }),
  runtimeHealth: runtimeHealthSchema,
  runtimeStatus: z.enum(['unreported', 'receipts_available']),
  receipts: z.array(z.object({ component: z.string(), generation: z.number(), appliedHash: z.string(), effectiveSampleTimeMs: z.number().nullable(),
    state: z.enum(['pending_boundary', 'applied', 'failed']), error: z.string().nullable(), heartbeatAtMs: z.number() })),
  sensorCalibration: z.array(z.object({ id: z.number(), sensorType: z.string(), status: z.string(), qualityScore: z.number().nullable(),
    createdAtMs: z.number(), expiresAtMs: z.number().nullable(), freshness: z.enum(['expired', 'current', 'unknown']),
    sourceWindowStartMs: z.number().nullable(), sourceWindowEndMs: z.number().nullable() })),
  activationAvailable: z.boolean(), limitations: z.array(z.string()),
})
