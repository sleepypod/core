import { createDemoBacktestHandlers } from './biometric-backtests'
import { datasetHandlers } from './biometric-datasets'
import { hash, uuid } from './biometric-utils'
import { referenceHandlers } from './biometric-references'
import { biometricManifest, defaultConfig, legacyStageOverrides, resolveOverrides } from '@/src/biometrics/algorithms/registry-core'
import { canonicalJson } from '@/src/biometrics/algorithms/canonical-json'
import type { DemoHandlers, RouterOutputs, RouterInputs } from '../types'
import { stageClassifierSchema, type StageClassifier } from '@/src/lib/sleep-stage-rules'

type Revision = RouterOutputs['biometricTuning']['getProfileRevision']
const revisions: Revision[] = []
const requests = new Map<string, { fingerprint: string, revision: Revision }>()

const getRevision = (id: string) => {
  const revision = revisions.find(row => row.id === id)
  if (!revision) throw new Error('NOT_FOUND: demo profile revision')
  return structuredClone(revision)
}
async function resolve(overrides: Parameters<typeof resolveOverrides>[0], baseManifestHash?: string) {
  const manifestHash = await hash(biometricManifest)
  if (baseManifestHash !== undefined && baseManifestHash !== manifestHash) throw new Error('PROFILE_INCOMPATIBLE: unknown base manifest')
  const result = resolveOverrides(overrides)
  return { ...result, hash: await hash(result.resolved), manifestHash }
}

type Side = 'left' | 'right'
type Event = RouterOutputs['biometricTuning']['activateProfile']
type Binding = RouterOutputs['biometricTuning']['getProfileOverview']['desired']['binding']
const bindings: Record<Side, Binding> = {
  left: { side: 'left', generation: 0, desiredRevisionId: null, previousRevisionId: null, updatedAtMs: 0 },
  right: { side: 'right', generation: 0, desiredRevisionId: null, previousRevisionId: null, updatedAtMs: 0 },
}
const events: Array<{ event: Event, readyAtMs: number }> = []
const activationRequests = new Map<string, { fingerprint: string, event: Event }>()
const noHealth = { state: 'unreported' as const, staleAfterMs: 120000, components: [] }
let mutationQueue: Promise<unknown> = Promise.resolve()
async function selected(side: Side, id: string | null) {
  const revision = id === null ? null : getRevision(id)
  if (revision && revision.side !== side) throw new Error('PROFILE_INCOMPATIBLE: wrong side')
  return resolve(revision?.overrides ?? [], revision?.baseManifestHash)
}
function observed(event: Event): Event {
  const stored = events.find(row => row.event.id === event.id)
  return { ...structuredClone(event), state: stored && Date.now() >= stored.readyAtMs ? 'applied' : 'pending_boundary' }
}
function serializeMutation<T>(action: () => Promise<T>): Promise<T> {
  const work = mutationQueue.then(action)
  mutationQueue = work.catch(() => {})
  return work
}
type ActivationInput = RouterInputs['biometricTuning']['rollbackProfile'] & { action: 'activate' | 'rollback' | 'reset' }
function activate(input: ActivationInput) {
  return serializeMutation(() => activateNow(input))
}
async function activateNow(input: ActivationInput) {
  if (input.allowUnvalidated !== true) throw new Error('Explicit unvalidated acknowledgement required')
  const fingerprint = await hash(input)
  const prior = activationRequests.get(input.idempotencyKey)
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error('REVISION_CONFLICT: activation request changed')
    return structuredClone(prior.event)
  }
  const binding = bindings[input.side]
  if (binding.generation !== input.expectedGeneration) throw new Error('STALE_BINDING: inspect the current demo profile')
  if (input.action === 'rollback' && (binding.generation === 0 || input.revisionId !== binding.previousRevisionId)) throw new Error('INVALID_SELECTION: rollback must select the previous binding')
  const next = await selected(input.side, input.revisionId)
  if (next.hash !== input.expectedResolvedHash) throw new Error('REVISION_CONFLICT: resolved hash changed')
  const previous = await selected(input.side, binding.desiredRevisionId)
  const now = Date.now(), generation = binding.generation + 1
  const event: Event = { id: uuid(), side: input.side, generation, action: input.action, previousRevisionId: binding.desiredRevisionId, nextRevisionId: input.revisionId,
    previousHash: previous.hash, nextHash: next.hash, evaluationId: null, evidence: { status: 'manual_unvalidated', simulated: true },
    requester: input.requester, state: 'pending_boundary', reason: 'SIMULATED DEMO: no live processor or hardware activation.', createdAtMs: now, updatedAtMs: now }
  bindings[input.side] = { side: input.side, generation, desiredRevisionId: input.revisionId, previousRevisionId: binding.desiredRevisionId, updatedAtMs: now }
  events.unshift({ event, readyAtMs: now + (input.boundary === 'immediate' ? 1000 : 3000) })
  activationRequests.set(input.idempotencyKey, { fingerprint, event })
  return structuredClone(event)
}

async function createDemoRevision(input: RouterInputs['biometricTuning']['createProfileRevision']): Promise<Revision> {
  const result = await resolve(input.overrides, input.baseManifestHash)
  const normalized = { ...input, baseManifestHash: result.manifestHash }
  if (normalized.parentRevisionId === undefined) delete normalized.parentRevisionId
  const fingerprint = await hash(normalized)
  const key = input.idempotencyKey
  const previous = requests.get(key)
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT: demo profile request changed')
    return structuredClone(previous.revision)
  }
  const parent = input.parentRevisionId ? getRevision(input.parentRevisionId) : null
  if (parent && parent.side !== input.side) throw new Error('PROFILE_INCOMPATIBLE: wrong side')
  const familyId = parent?.familyId ?? uuid()
  const revision: Revision = { ...input, id: uuid(), familyId, revision: 1 + Math.max(0, ...revisions.filter(row => row.familyId === familyId).map(row => row.revision)),
    baseManifestHash: result.manifestHash, baseManifest: biometricManifest, resolved: result.resolved, resolvedHash: result.hash,
    dependencyHashes: biometricManifest.dependencyHashes, parentRevisionId: parent?.id ?? null, requestHash: fingerprint, createdAtMs: Date.now() }
  revisions.unshift(revision)
  requests.set(key, { fingerprint, revision })
  return structuredClone(revision)
}

/** Compatibility editor and calibration use one simulated adoption history. */
export async function demoStageView(side: Side): Promise<RouterOutputs['biometricTuning']['getProfileOverview']['stageView']> {
  const adopted = events.find(row => row.event.side === side && row.readyAtMs <= Date.now())?.event
  const effective = await selected(side, adopted?.nextRevisionId ?? null)
  return { classifier: effective.resolved.sleep_stages,
    isDefault: canonicalJson(effective.resolved.sleep_stages) === canonicalJson(defaultConfig.sleep_stages),
    provenance: { interpretation: 'current_classifier_view' as const, source: 'demo', generation: adopted?.generation ?? null,
      revisionId: adopted?.nextRevisionId ?? null, bundleHash: effective.hash, stageHash: await hash(effective.resolved.sleep_stages),
      manifestHash: effective.manifestHash, effectiveSampleTimeMs: null, warning: 'SIMULATED DEMO: no live processor.' } }
}

export async function demoStageSettings(side: Side) {
  const view = await demoStageView(side)
  const binding = bindings[side]
  const desired = await selected(side, binding.desiredRevisionId)
  return { ...view, pending: binding.generation > (view.provenance.generation ?? 0)
    ? { classifier: desired.resolved.sleep_stages, generation: binding.generation, warning: 'SIMULATED DEMO: waiting for adoption.' }
    : null }
}

export function writeDemoStageClassifier(side: Side, classifier: StageClassifier | null, recordChange?: (before: StageClassifier | null) => void) {
  return serializeMutation(async () => {
    const parsed = classifier === null ? null : stageClassifierSchema.parse(classifier)
    const binding = bindings[side]
    const current = binding.desiredRevisionId ? getRevision(binding.desiredRevisionId) : null
    const overrides = (current?.overrides ?? []).filter(override => !override.path.startsWith('sleep_stages.'))
    if (parsed) overrides.push(...legacyStageOverrides(parsed))
    const key = `legacy-stage-write:${uuid()}`
    const revision = overrides.length
      ? await createDemoRevision({ side, overrides, origin: 'manual', requester: 'legacy-stage-settings',
          idempotencyKey: key, ...(current ? { parentRevisionId: current.id } : {}) })
      : null
    const event = await activateNow({ side, action: revision ? 'activate' : 'reset', revisionId: revision?.id ?? null,
      expectedGeneration: binding.generation, expectedResolvedHash: revision?.resolvedHash ?? await hash(defaultConfig),
      boundary: 'immediate', requester: 'legacy-stage-settings', idempotencyKey: key, allowUnvalidated: true })
    const stagePersonalized = current?.overrides.some(override => override.path.startsWith('sleep_stages.'))
    recordChange?.(stagePersonalized && current ? resolveOverrides(current.overrides).resolved.sleep_stages : null)
    return { classifier: parsed ?? defaultConfig.sleep_stages, isDefault: parsed === null,
      activation: { generation: event.generation, revisionId: revision?.id ?? null, state: event.state } }
  })
}

export const biometricTuning: DemoHandlers<'biometricTuning'> = {
  reviewValidatedActivation: () => { throw new Error('SIMULATED DEMO: synthetic evidence cannot validate a live profile.') },
  activateValidatedProfile: () => { throw new Error('SIMULATED DEMO: validated activation is unavailable.') },
  ...referenceHandlers,
  ...datasetHandlers,
  ...createDemoBacktestHandlers(async (side, revisionId, generation) => {
    const candidate = await selected(side, revisionId)
    const defaults = await resolve([])
    const adopted = events.find(row => row.event.side === side && row.readyAtMs <= Date.now())?.event
    const stage = await selected(side, adopted?.nextRevisionId ?? null)
    const current = { ...structuredClone(defaultConfig), sleep_stages: stage.resolved.sleep_stages }
    const currentHash = await hash(current)
    if (bindings[side].generation !== generation) throw new Error('REVISION_CONFLICT: profile binding changed')
    return [
      { label: 'default', revisionId: null, manifestHash: defaults.manifestHash, resolvedHash: defaults.hash, resolved: defaults.resolved },
      { label: 'current', revisionId: null, manifestHash: defaults.manifestHash, resolvedHash: currentHash, resolved: current },
      { label: 'candidate', revisionId, manifestHash: candidate.manifestHash, resolvedHash: candidate.hash, resolved: candidate.resolved },
    ]
  }),
  describeAnalysisExport: () => { throw new Error('SIMULATED DEMO: analysis snapshots need a real pod database and RAW archives.') },
  getManifest: async () => ({ manifest: biometricManifest, manifestHash: await hash(biometricManifest), activationAvailable: true }),
  resolveProfile: input => resolve(input.overrides, input.baseManifestHash),
  createProfileRevision: createDemoRevision,
  getProfileRevision: input => getRevision(input.id),
  listProfileRevisions: (input) => {
    const rows = revisions.filter(row => row.side === input.side && (!input.familyId || row.familyId === input.familyId)
      && (input.beforeCreatedAtMs === undefined || row.createdAtMs < input.beforeCreatedAtMs || (row.createdAtMs === input.beforeCreatedAtMs && row.id < (input.beforeId ?? ''))))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id))
    const items = rows.slice(0, 100), last = items[items.length - 1]
    return { items: structuredClone(items), nextCursor: rows.length > 100 && last ? { id: last.id, createdAtMs: last.createdAtMs } : null }
  },
  validateProfileRevision: async (input) => {
    const revision = getRevision(input.id)
    if (revision.side !== input.side) throw new Error('PROFILE_INCOMPATIBLE: wrong side')
    const result = await resolve(revision.overrides, revision.baseManifestHash)
    return { id: revision.id, resolvedHash: result.hash, compatible: true, evidence: 'not_checked', limitations: ['Demo profile; no biological validation or hardware activation.'] }
  },
  diffProfileRevision: async (input) => {
    const before = await selected(input.side, input.againstRevisionId), after = await selected(input.side, input.revisionId)
    const changes: Array<{ path: string, before: unknown, after: unknown }> = []
    const walk = (left: unknown, right: unknown, path: string) => {
      if (canonicalJson(left) === canonicalJson(right)) return
      if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
        for (const key of Object.keys(left)) walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
      }
      else changes.push({ path, before: left, after: right })
    }
    walk(before.resolved, after.resolved, '')
    const oldIntent = new Map(before.overrides.map(row => [row.path, row.value])), newIntent = new Map(after.overrides.map(row => [row.path, row.value]))
    const intentChangedPaths = [...new Set([...oldIntent.keys(), ...newIntent.keys()])].filter(path => !oldIntent.has(path) || !newIntent.has(path) || canonicalJson(oldIntent.get(path)) !== canonicalJson(newIntent.get(path)))
    return { revisionId: input.revisionId, againstRevisionId: input.againstRevisionId, beforeHash: before.hash, afterHash: after.hash, changes, intentChangedPaths }
  },
  activateProfile: input => activate({ ...input, action: 'activate' }),
  resetProfile: input => activate({ ...input, revisionId: null, action: 'reset' }),
  rollbackProfile: input => activate({ ...input, action: 'rollback' }),
  getActivationStatus: ({ side, id }) => {
    const row = events.find(row => row.event.side === side && (id ? row.event.id === id : row.event.generation === bindings[side].generation))
    if (id && !row) throw new Error('NOT_FOUND: demo activation event')
    const event = row ? observed(row.event) : null
    return { desiredGeneration: bindings[side].generation, isCurrent: event?.generation === bindings[side].generation, event,
      deliveryState: event ? 'delivered' : null, observedState: event?.state === 'applied' ? 'applied' : event ? 'pending_boundary' : 'unreported', receiptHealth: noHealth, receipts: [] }
  },
  getProfileOverview: async ({ side }) => {
    const binding = structuredClone(bindings[side])
    const desired = await selected(side, binding.desiredRevisionId)
    const stageView = await demoStageView(side)
    return { desired: { binding, resolved: desired.resolved, hash: desired.hash, isDefault: binding.desiredRevisionId === null, warning: null },
      stageView,
      legacyStageView: { classifier: defaultConfig.sleep_stages, personalized: false, migrationPending: false },
      runtimeHealth: noHealth, runtimeStatus: 'unreported', receipts: [], sensorCalibration: [], activationAvailable: true,
      limitations: ['SIMULATED DEMO: activation boundaries are simulated after a short delay. No live processor or hardware activation.'] }
  },
  listActivationHistory: ({ side, beforeGeneration }) => {
    const rows = events.filter(row => row.event.side === side && (beforeGeneration === undefined || row.event.generation < beforeGeneration))
    const items = rows.slice(0, 50).map(row => observed(row.event))
    return { items, nextGeneration: rows.length > 50 ? items[items.length - 1].generation : null }
  },
}
