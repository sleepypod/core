/**
 * Personal sleep stage models on the pod.
 *
 * A model trained off the pod (on the iPhone with Create ML, or in the
 * analysis container with scikit-learn, see
 * docs/research/sleep-stage-calibration/personal-models.py --export) arrives
 * as a portable JSON document: a random forest as plain trees or a logistic
 * regression as weights, plus the feature contract it was trained on and
 * test vectors it must reproduce. This module validates such a document,
 * computes the contract's features from a night's vitals and movement
 * exactly as sleepypod-ios `StageFeatures` and the Python port do, evaluates
 * the model per 5-minute epoch, and post-processes like the rules engine.
 *
 * Evaluating 200 trees of depth 4 is about 800 comparisons per epoch; a night
 * costs well under a millisecond. Training never runs here.
 */
import { z } from 'zod'
import { DEFAULT_STAGE_RULESET, SLEEP_STAGES, type StageRuleset } from './sleep-stage-rules'
import type { SleepEpoch, SleepStage, SleepStageBlock } from './sleep-stages'

export const STAGE_MODEL_EPOCH_SECONDS = 300
const WINDOW_HALF_SECONDS = 450

/** Column names of the two feature contracts, in the order models expect them. */
export const CHALLENGER_CONTRACT = ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'] as const
export const POD_NATIVE_CONTRACT = [...CHALLENGER_CONTRACT, 'hrvRel', 'hrv15Rel', 'hr15StdRel', 'br15Std', 'motion15', 'minutesSinceBed'] as const
export const STAGE_MODEL_CONTRACTS = { challenger: CHALLENGER_CONTRACT, podNative: POD_NATIVE_CONTRACT } as const
export type StageModelContract = keyof typeof STAGE_MODEL_CONTRACTS

const number = z.number().finite()

/** One tree as parallel arrays: node i splits on feature f[i] at t[i] (f[i] = -1 is a leaf with class votes v[i]). */
const treeSchema = z.object({
  f: z.array(z.number().int().min(-1)),
  t: z.array(number),
  l: z.array(z.number().int().min(-1)),
  r: z.array(z.number().int().min(-1)),
  v: z.array(z.array(number.min(0))),
}).strict().superRefine((tree, ctx) => {
  const n = tree.f.length
  if ([tree.t, tree.l, tree.r, tree.v].some(a => a.length !== n)) ctx.addIssue({ code: 'custom', message: 'tree arrays differ in length' })
  if (n === 0) ctx.addIssue({ code: 'custom', message: 'tree has no nodes' })
  for (let i = 0; i < n; i++) {
    if (tree.f[i] >= 0 && (tree.l[i] < 0 || tree.l[i] >= n || tree.r[i] < 0 || tree.r[i] >= n)) {
      ctx.addIssue({ code: 'custom', message: `node ${i} points outside the tree` })
    }
    if (tree.f[i] >= 0 && (tree.l[i] <= i || tree.r[i] <= i)) ctx.addIssue({ code: 'custom', message: `node ${i} does not point forward` })
  }
})

const testVectorSchema = z.object({ inputs: z.record(z.string(), number), expected: z.number().int().min(0).max(3) }).strict()

export const stageModelSchema = z.object({
  version: z.string().min(1).max(120),
  kind: z.enum(['forest', 'logistic']),
  /** Class order of every vote, score and `expected`: always the four stages in StageScore order. */
  classes: z.tuple([z.literal('wake'), z.literal('light'), z.literal('deep'), z.literal('rem')]),
  featureContract: z.array(z.string().min(1)).min(1).max(32),
  epochSeconds: z.literal(STAGE_MODEL_EPOCH_SECONDS).default(STAGE_MODEL_EPOCH_SECONDS),
  /** Forest: trees over feature indices into `featureContract`. */
  trees: z.array(treeSchema).max(1000).optional(),
  /** Logistic: StandardScaler followed by a linear model; `coef` rows follow `classIndices`. */
  logistic: z.object({
    mean: z.array(number),
    scale: z.array(number),
    coef: z.array(z.array(number)),
    intercept: z.array(number),
    /** Class index (into `classes`) of each coef row; a two-class fit has one row for classIndices[1]. */
    classIndices: z.array(z.number().int().min(0).max(3)).min(2).max(4),
  }).strict().optional(),
  hyperparameters: z.record(z.string(), number).optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  trainedAt: z.string().optional(),
  source: z.string().max(200).optional(),
  testVectors: z.array(testVectorSchema).min(1).max(64),
}).strict().superRefine((model, ctx) => {
  const n = model.featureContract.length
  if (model.kind === 'forest') {
    if (!model.trees?.length) ctx.addIssue({ code: 'custom', path: ['trees'], message: 'a forest needs trees' })
    for (const [i, tree] of (model.trees ?? []).entries()) {
      if (tree.f.some(f => f >= n)) ctx.addIssue({ code: 'custom', path: ['trees', i], message: 'split feature outside the contract' })
      if (tree.v.some(v => v.length !== 4)) ctx.addIssue({ code: 'custom', path: ['trees', i], message: 'leaf votes must have four classes' })
    }
  }
  else {
    const lr = model.logistic
    if (!lr) {
      ctx.addIssue({ code: 'custom', path: ['logistic'], message: 'a logistic model needs weights' })
      return
    }
    const rows = lr.classIndices.length === 2 ? 1 : lr.classIndices.length
    if (lr.mean.length !== n || lr.scale.length !== n) ctx.addIssue({ code: 'custom', path: ['logistic'], message: 'scaler does not match the contract' })
    if (lr.coef.length !== rows || lr.coef.some(c => c.length !== n) || lr.intercept.length !== rows) {
      ctx.addIssue({ code: 'custom', path: ['logistic'], message: 'coef and intercept do not match the classes and contract' })
    }
  }
  for (const [i, vector] of model.testVectors.entries()) {
    if (model.featureContract.some(c => !(c in vector.inputs))) ctx.addIssue({ code: 'custom', path: ['testVectors', i], message: 'test vector misses a contract column' })
  }
})
export type StageModel = z.infer<typeof stageModelSchema>

export interface StageModelPrediction {
  classIndex: number
  stage: SleepStage
  /** Per class in `classes` order, summing to 1. */
  probabilities: number[]
}

/** One epoch's inputs by column name in, a stage out. */
export function evaluateStageModel(model: StageModel, values: Record<string, number>): StageModelPrediction {
  const x = model.featureContract.map((column) => {
    const v = values[column]
    if (v === undefined || !Number.isFinite(v)) throw new Error(`feature ${column} is missing`)
    return v
  })
  let probabilities: number[]
  if (model.kind === 'forest') {
    const trees = model.trees ?? []
    const sum = [0, 0, 0, 0]
    for (const tree of trees) {
      let node = 0
      while (tree.f[node] >= 0) node = x[tree.f[node]] <= tree.t[node] ? tree.l[node] : tree.r[node]
      const votes = tree.v[node]
      const total = votes.reduce((a, b) => a + b, 0)
      for (let c = 0; c < 4; c++) sum[c] += total > 0 ? votes[c] / total : 0.25
    }
    probabilities = sum.map(s => s / Math.max(trees.length, 1))
  }
  else {
    const lr = model.logistic
    if (!lr) throw new Error('logistic model without weights')
    const zed = x.map((v, i) => (lr.scale[i] === 0 ? 0 : (v - lr.mean[i]) / lr.scale[i]))
    const scores = lr.coef.map((row, k) => row.reduce((acc, w, i) => acc + w * zed[i], 0) + lr.intercept[k])
    probabilities = [0, 0, 0, 0]
    if (lr.classIndices.length === 2) {
      const p = 1 / (1 + Math.exp(-scores[0]))
      probabilities[lr.classIndices[1]] = p
      probabilities[lr.classIndices[0]] = 1 - p
    }
    else {
      const max = Math.max(...scores)
      const exps = scores.map(s => Math.exp(s - max))
      const total = exps.reduce((a, b) => a + b, 0)
      lr.classIndices.forEach((c, k) => {
        probabilities[c] = exps[k] / total
      })
    }
  }
  let classIndex = 0
  for (let c = 1; c < 4; c++) {
    if (probabilities[c] > probabilities[classIndex]) classIndex = c
  }
  return { classIndex, stage: SLEEP_STAGES[classIndex], probabilities }
}

/** Indices of the model's own test vectors it gets wrong; a model that fails any is refused. */
export function failingTestVectors(model: StageModel): number[] {
  const failing: number[] = []
  model.testVectors.forEach((vector, i) => {
    try {
      if (evaluateStageModel(model, vector.inputs).classIndex !== vector.expected) failing.push(i)
    }
    catch {
      failing.push(i)
    }
  })
  return failing
}

/** The contract whose columns match the model's exactly, or null for an unknown contract. */
export function stageModelContract(model: StageModel): StageModelContract | null {
  for (const [name, columns] of Object.entries(STAGE_MODEL_CONTRACTS)) {
    if (columns.length === model.featureContract.length && columns.every((c, i) => c === model.featureContract[i])) return name as StageModelContract
  }
  return null
}

// MARK: Features (must stay identical to sleepypod-ios StageFeatures and personal-models.py)

interface VitalsLike { timestamp: Date, heartRate: number | null, hrv: number | null, breathingRate: number | null }
interface MovementLike { timestamp: Date, totalMovement: number }

export interface FeatureEpoch { start: number, values: Record<string, number> }

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}
function populationStd(values: number[]): number {
  if (values.length === 0) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / values.length)
}
function zScores(values: number[]): number[] {
  const m = mean(values)
  const s = populationStd(values)
  return values.map(v => (s === 0 ? 0 : (v - m) / s))
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * The contract's rows for a night: 5-minute epochs from bed entry (a trailing
 * partial epoch dropped), epochs without a heart-rate sample skipped, z-scores
 * per night with the population std. Timestamps are unix seconds. Only rows
 * inside [enteredBed, leftBed) take part, as on the phone.
 */
export function stageModelFeatures(contract: StageModelContract, enteredBed: Date, leftBed: Date, vitals: VitalsLike[], movement: MovementLike[]): FeatureEpoch[] {
  const entered = enteredBed.getTime() / 1000
  const left = leftBed.getTime() / 1000
  const night = left - entered
  if (night < STAGE_MODEL_EPOCH_SECONDS) return []
  const count = Math.floor(night / STAGE_MODEL_EPOCH_SECONDS)
  const inWindow = <T extends { timestamp: Date }>(rows: T[]) => rows.filter((r) => {
    const t = r.timestamp.getTime() / 1000
    return t >= entered && t < left
  })
  const rows = inWindow(vitals)
  const moves = inWindow(movement)
  const finite = (v: number | null): v is number => v !== null && Number.isFinite(v)
  const hr = rows.filter(r => finite(r.heartRate)).map(r => ({ t: r.timestamp.getTime() / 1000, v: r.heartRate as number }))
  const hrv = rows.filter(r => finite(r.hrv)).map(r => ({ t: r.timestamp.getTime() / 1000, v: r.hrv as number }))
  const br = rows.filter(r => finite(r.breathingRate)).map(r => ({ t: r.timestamp.getTime() / 1000, v: r.breathingRate as number }))
  const mv = moves.map(r => ({ t: r.timestamp.getTime() / 1000, v: r.totalMovement }))

  const kept: { start: number, hr: number, hrStd: number, motion: number }[] = []
  for (let i = 0; i < count; i++) {
    const start = entered + i * STAGE_MODEL_EPOCH_SECONDS
    const end = start + STAGE_MODEL_EPOCH_SECONDS
    const samples = hr.filter(s => s.t >= start && s.t < end).map(s => s.v)
    if (samples.length === 0) continue
    const motion = mv.filter(s => s.t >= start && s.t < end).reduce((a, s) => a + s.v, 0)
    kept.push({ start, hr: mean(samples), hrStd: samples.length < 2 ? 0 : populationStd(samples), motion })
  }
  const hrZ = zScores(kept.map(k => k.hr))
  const hrStdZ = zScores(kept.map(k => k.hrStd))
  const motionZ = zScores(kept.map(k => Math.log(1 + k.motion)))
  const out: FeatureEpoch[] = kept.map((k, i) => ({
    start: k.start,
    values: { hrZ: hrZ[i], hrStdZ: hrStdZ[i], motionZ: motionZ[i], nightFraction: (k.start - entered) / night },
  }))
  if (contract === 'challenger') return out

  const nightHRVMedian = median(hrv.map(s => s.v))
  const nightHRStd = populationStd(hr.map(s => s.v))
  const ratio = (value: number, denominator: number) => (denominator > 0 && Number.isFinite(denominator) ? value / denominator : 0)
  const window = (samples: { t: number, v: number }[], mid: number, half: number) => samples.filter(s => Math.abs(s.t - mid) <= half).map(s => s.v)
  for (const row of out) {
    const mid = row.start + STAGE_MODEL_EPOCH_SECONDS / 2
    const epochHRV = window(hrv, mid, STAGE_MODEL_EPOCH_SECONDS / 2)
    const hrv15 = window(hrv, mid, WINDOW_HALF_SECONDS)
    const hr15 = window(hr, mid, WINDOW_HALF_SECONDS)
    const br15 = window(br, mid, WINDOW_HALF_SECONDS)
    const motion15 = mv.filter(s => Math.abs(s.t - mid) <= WINDOW_HALF_SECONDS).reduce((a, s) => a + s.v, 0)
    row.values.hrvRel = epochHRV.length === 0 ? 0 : ratio(mean(epochHRV), nightHRVMedian)
    row.values.hrv15Rel = hrv15.length === 0 ? 0 : ratio(mean(hrv15), nightHRVMedian)
    row.values.hr15StdRel = hr15.length < 2 ? 0 : ratio(populationStd(hr15), nightHRStd)
    row.values.br15Std = br15.length < 2 ? 0 : populationStd(br15)
    row.values.motion15 = Math.log(1 + motion15)
    row.values.minutesSinceBed = (row.start - entered) / 60
  }
  return out
}

// MARK: Outliers

/**
 * The rules engine's outlier filter (sleep-stages.ts `filterOutliers`), ported rather than imported: that file
 * is a pinned numerical source of the biometrics manifest, and exporting from it would change the manifest hash.
 * Hard limits null a field; the HR spike filter nulls a reading more than `heartRateSpikeStdDevs` from its
 * ±2-sample window median.
 */
export function filterModelOutliers<T extends VitalsLike>(vitals: T[], limits: StageRuleset['outliers']): T[] {
  const inRange = (v: number | null, r: { min: number, max: number }) => v !== null && v >= r.min && v <= r.max
  return vitals.map((v, i) => {
    let heartRate = inRange(v.heartRate, limits.heartRate) ? v.heartRate : null
    const hrv = inRange(v.hrv, limits.hrv) ? v.hrv : null
    const breathingRate = inRange(v.breathingRate, limits.breathingRate) ? v.breathingRate : null
    if (heartRate !== null && limits.heartRateSpikeStdDevs > 0) {
      const windowHRs = vitals.slice(Math.max(0, i - 2), Math.min(vitals.length - 1, i + 2) + 1)
        .map(w => w.heartRate)
        .filter((hr): hr is number => inRange(hr, limits.heartRate))
      if (windowHRs.length > 0) {
        const sorted = [...windowHRs].sort((a, b) => a - b)
        const windowMedian = sorted[Math.floor(sorted.length / 2)]
        const windowMean = windowHRs.reduce((a, h) => a + h, 0) / windowHRs.length
        const stdDev = Math.sqrt(windowHRs.reduce((a, h) => a + (h - windowMean) ** 2, 0) / windowHRs.length)
        if (stdDev > 0 && Math.abs(heartRate - windowMedian) > limits.heartRateSpikeStdDevs * stdDev) heartRate = null
      }
    }
    return { ...v, heartRate, hrv, breathingRate }
  })
}

// MARK: Classification

/**
 * A night staged by the model: features from the outlier-filtered vitals (the
 * ruleset's limits, as the phone filters before training), one 5-minute epoch
 * per prediction, then the rules engine's smoothing (an isolated epoch between
 * two equal neighbours takes their stage) and transition constraints.
 */
export function classifyWithStageModel(
  model: StageModel,
  enteredBed: Date,
  leftBed: Date,
  vitals: VitalsLike[],
  movement: MovementLike[],
  ruleset: StageRuleset = DEFAULT_STAGE_RULESET,
): SleepEpoch[] {
  const contract = stageModelContract(model)
  if (!contract) throw new Error('unknown feature contract')
  const sorted = [...vitals].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  const filtered = filterModelOutliers(sorted, ruleset.outliers)
  const rows = stageModelFeatures(contract, enteredBed, leftBed, filtered, movement)
  const epochs: SleepEpoch[] = rows.map((row) => {
    const startMs = row.start * 1000
    const endMs = startMs + STAGE_MODEL_EPOCH_SECONDS * 1000
    const inEpoch = filtered.filter(v => v.timestamp.getTime() >= startMs && v.timestamp.getTime() < endMs)
    const avg = (pick: (v: VitalsLike) => number | null) => {
      const values = inEpoch.map(pick).filter((v): v is number => v !== null && Number.isFinite(v))
      return values.length === 0 ? null : mean(values)
    }
    const motion = movement.filter(m => m.timestamp.getTime() >= startMs && m.timestamp.getTime() < endMs).reduce((a, m) => a + m.totalMovement, 0)
    return {
      start: startMs,
      duration: STAGE_MODEL_EPOCH_SECONDS * 1000,
      stage: evaluateStageModel(model, row.values).stage,
      heartRate: avg(v => v.heartRate),
      hrv: avg(v => v.hrv),
      breathingRate: avg(v => v.breathingRate),
      movement: motion,
    }
  })
  if (ruleset.smoothIsolatedEpochs) {
    for (let i = 1; i < epochs.length - 1; i++) {
      if (epochs[i - 1].stage === epochs[i + 1].stage && epochs[i].stage !== epochs[i - 1].stage) epochs[i].stage = epochs[i - 1].stage
    }
  }
  for (let i = 1; i < epochs.length; i++) {
    const t = ruleset.transitions.find(t => t.from === epochs[i - 1].stage && t.to === epochs[i].stage)
    if (t && t.via !== epochs[i].stage) epochs[i].stage = t.via
  }
  return epochs
}

/** Blocks for drawing, from classified epochs. */
export function stageModelBlocks(epochs: SleepEpoch[]): SleepStageBlock[] {
  const blocks: SleepStageBlock[] = []
  for (const e of epochs) {
    const last = blocks[blocks.length - 1]
    if (last && last.stage === e.stage && last.end === e.start) last.end = e.start + e.duration
    else blocks.push({ start: e.start, end: e.start + e.duration, stage: e.stage })
  }
  return blocks
}
