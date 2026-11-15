/**
 * Model set manifests (`modelset-v1`) from sleepypod/training: the versions of every node a stage
 * model was trained on, uploaded beside the model and stored with its library entry.
 *
 * `pinned` nodes must be installed exactly; `expected` nodes are owned elsewhere (vitals belong to
 * biometrics tuning) and a difference is recorded on each night instead of refused. Movement models
 * do not run on the pod yet, so a set pinning one is refused until they do.
 */
import { z } from 'zod'
import { dataHash } from '@/src/biometrics/algorithms/canonical'
import type { StageModel } from './personal-stage-model'

export const MODEL_SET_FORMAT = 'modelset-v1'
const MAX_MODEL_SET_BYTES = 64 * 1024

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected a lowercase hex SHA-256')

/** The version of the vitals node: the biometrics manifest hash and the resolved profile hash. */
export const vitalsIdentitySchema = z.object({ engine: sha256, profile: sha256 }).strict()
export type VitalsIdentity = z.infer<typeof vitalsIdentitySchema>

export const modelSetSchema = z.object({
  formatVersion: z.literal(MODEL_SET_FORMAT),
  id: z.string().min(1).max(200),
  nodes: z.object({
    stage: z.object({
      version: z.string().min(1).max(120),
      sha256,
      contract: z.string().min(1).max(120).optional(),
      binding: z.literal('pinned'),
    }).strict(),
    vitals: vitalsIdentitySchema.extend({ binding: z.literal('expected') }).strict().optional(),
    movementModel: z.object({
      version: z.string().min(1).max(120),
      sha256,
      binding: z.literal('pinned'),
    }).strict().optional(),
  }).strict(),
  /** Stored as given; the pod does not interpret training or evaluation metadata. */
  training: z.record(z.string(), z.unknown()).optional(),
  evaluation: z.record(z.string(), z.unknown()).optional(),
}).strict().refine(set => Buffer.byteLength(JSON.stringify(set)) <= MAX_MODEL_SET_BYTES,
  { message: `a model set manifest is at most ${MAX_MODEL_SET_BYTES / 1024} KB` })
export type ModelSet = z.infer<typeof modelSetSchema>

/**
 * SHA-256 of the model as the pod stores it (after `epochSeconds` defaults to 300), in core's
 * canonical JSON (finite-binary64-json-v1, see canonical-json.ts) with the larger data budget.
 */
export function stageModelSha256(model: StageModel): string {
  return dataHash(model)
}

/** Why a set cannot be stored with this model, or null when it can. */
export function modelSetProblem(set: ModelSet, model: StageModel, contract: string | null): string | null {
  if (set.nodes.movementModel) {
    return 'Movement models are not supported on this pod yet; upload the stage model without nodes.movementModel'
  }
  if (set.nodes.stage.version !== model.version) {
    return `Model set names stage version ${set.nodes.stage.version} but the model is ${model.version}`
  }
  if (set.nodes.stage.contract !== undefined && set.nodes.stage.contract !== contract) {
    return `Model set names contract ${set.nodes.stage.contract} but the model's features are ${contract ?? 'unknown'}`
  }
  const actual = stageModelSha256(model)
  if (set.nodes.stage.sha256 !== actual) {
    return `Model set pins stage sha256 ${set.nodes.stage.sha256} but this model hashes to ${actual}`
  }
  return null
}

/** What produced a night's vitals: one identity, several (a change mid-night), or unrecorded. */
export type ActualVitals = VitalsIdentity | 'mixed' | 'unknown'

export const inputMismatchSchema = z.object({
  expected: vitalsIdentitySchema,
  actual: z.union([vitalsIdentitySchema, z.literal('mixed'), z.literal('unknown')]),
})
export type InputMismatch = z.infer<typeof inputMismatchSchema>

/** Null when the set expects nothing of the vitals, or when they match exactly. */
export function inputMismatch(set: ModelSet | null, actual: ActualVitals | null): InputMismatch | null {
  const vitals = set?.nodes.vitals
  if (!vitals || actual === null) return null
  const expected = { engine: vitals.engine, profile: vitals.profile }
  if (typeof actual === 'object' && actual.engine === expected.engine && actual.profile === expected.profile) return null
  return { expected, actual }
}
