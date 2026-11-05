import { canonicalJson } from '../algorithms/canonical-json'
const utf8 = new TextEncoder()
import { REFERENCE_ADAPTER_VERSION, REFERENCE_LIMITS, REFERENCE_UNITS, referenceImportSchema, referenceRowSchema, type NormalizedMeasurement, type PreviewSummary, type ReferenceImportInput } from './contracts'
import { ReferenceInputError, timestampResolver } from './time'

/** Validate size/depth before copying, hashing or parsing untrusted exports. */
export function assertBoundedReferenceData(input: unknown): void {
  const stack = [{ value: input, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0, stringBytes = 0
  while (stack.length) {
    const entry = stack.pop()
    if (!entry) break
    const { value, depth } = entry
    if (++nodes > REFERENCE_LIMITS.nodes || depth > REFERENCE_LIMITS.depth) throw new ReferenceInputError('RESOURCE_LIMIT', 'Reference JSON is too large or deeply nested')
    if (typeof value === 'string') stringBytes += utf8.encode(value).byteLength
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new ReferenceInputError('NON_FINITE_VALUE', 'Reference values must be finite JSON numbers')
    }
    else if (value !== null && typeof value === 'object') {
      if (seen.has(value)) throw new ReferenceInputError('INVALID_JSON', 'Reference input must be a JSON tree')
      seen.add(value)
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ReferenceInputError('INVALID_JSON', 'Reference input must contain plain JSON objects')
      for (const [key, child] of Object.entries(value)) {
        stringBytes += utf8.encode(key).byteLength
        stack.push({ value: child, depth: depth + 1 })
      }
    }
    else if (value !== null && typeof value !== 'boolean') throw new ReferenceInputError('INVALID_JSON', 'Reference input contains a non-JSON value')
    if (stringBytes > REFERENCE_LIMITS.bytes) throw new ReferenceInputError('RESOURCE_LIMIT', 'Reference upload exceeds 2 MiB')
  }
  if (utf8.encode(JSON.stringify(input)).byteLength > REFERENCE_LIMITS.bytes) throw new ReferenceInputError('RESOURCE_LIMIT', 'Reference upload exceeds 2 MiB')
}

function normalizeRow(raw: unknown, subjectId: string, resolveTime: (value: string | number) => number): NormalizedMeasurement {
  const row = referenceRowSchema.parse(raw)
  if (row.subjectId !== undefined && row.subjectId !== subjectId) throw new ReferenceInputError('SUBJECT_MISMATCH', 'Row belongs to a different subject; split the export and map each sleeper explicitly')
  const point = row.timestampMs ?? row.timestamp
  const start = row.startMs ?? row.start
  const end = row.endMs ?? row.end
  if ((row.timestampMs !== undefined && row.timestamp !== undefined)
    || (row.startMs !== undefined && row.start !== undefined) || (row.endMs !== undefined && row.end !== undefined)
    || (point !== undefined && (start !== undefined || end !== undefined))) {
    throw new ReferenceInputError('AMBIGUOUS_TIME_FIELDS', 'Specify a single point or interval time representation')
  }
  const temporalKind = point !== undefined ? 'point' : 'interval'
  if (point === undefined && (start === undefined || end === undefined)) throw new ReferenceInputError('MISSING_TIMESTAMP', 'Provide timestampMs or startMs/endMs, or ISO equivalents')
  const startMs = resolveTime(point ?? start ?? '')
  const endMs = point !== undefined ? startMs : resolveTime(end ?? '')
  if (temporalKind === 'interval' && endMs <= startMs) throw new ReferenceInputError('INVALID_INTERVAL', 'end must be after start')
  if (endMs - startMs > 24 * 60 * 60 * 1000) throw new ReferenceInputError('INVALID_INTERVAL', 'A reference interval may span at most 24 hours')
  const aggregation = row.aggregation ?? (row.metric === 'sleep_stages' ? 'stage' : temporalKind === 'point' ? 'instant' : 'mean')
  if ((temporalKind === 'interval' && aggregation === 'instant') || (row.metric !== 'sleep_stages' && aggregation === 'stage')) throw new ReferenceInputError('INVALID_AGGREGATION', 'Aggregation does not match the measurement semantics')
  const exclusions: string[] = []
  let value: number | null = null, stage: NormalizedMeasurement['stage'] = null, unit: string
  if (row.metric === 'sleep_stages') {
    if (typeof row.value !== 'string' || row.unit !== 'stage' || temporalKind !== 'interval' || aggregation !== 'stage') throw new ReferenceInputError('INCOMPATIBLE_METRIC', 'Sleep stages require a labeled interval with unit stage')
    stage = row.value
    unit = 'stage'
    if (!['wake', 'light', 'deep', 'rem'].includes(stage)) exclusions.push('unclassified_stage')
  }
  else {
    if (typeof row.value !== 'number') throw new ReferenceInputError('INCOMPATIBLE_METRIC', 'Vital measurements require numeric values')
    const { unit: storedUnit, accepted } = REFERENCE_UNITS[row.metric]
    const units: Record<string, number> = accepted
    if (!Object.hasOwn(units, row.unit)) throw new ReferenceInputError('UNSUPPORTED_UNIT', `Unsupported unit for ${row.metric}`)
    value = row.value * units[row.unit]
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new ReferenceInputError('INVALID_VALUE', 'Measurements must be finite, nonnegative and within the safe numeric range after conversion')
    unit = storedUnit
    if (row.metric === 'hrv_unknown') exclusions.push('unknown_hrv_definition')
    if (row.metric === 'window_ibi_variability_v1' && (row.windowMs !== 300000 || aggregation !== 'window_index')) exclusions.push('incompatible_hrv_window')
  }
  return { recordKey: row.recordKey, metric: row.metric, value, stage, unit, startMs, endMs, temporalKind,
    aggregation, windowMs: row.windowMs ?? null, quality: row.quality ?? null,
    scorable: exclusions.length === 0, exclusions, original: row }
}

export function normalizeReferenceImport(raw: ReferenceImportInput): { summary: Omit<PreviewSummary, 'contentHash'>, measurements: NormalizedMeasurement[], uploadJson: string } {
  assertBoundedReferenceData(raw)
  const input = referenceImportSchema.parse(raw)
  const resolveTime = timestampResolver(input.timePolicy)
  const rejected = new Map<number, { code: string, message: string }>()
  const normalized: Array<{ row: number, measurement: NormalizedMeasurement }> = []
  for (const [index, value] of input.rows.entries()) {
    try {
      const measurement = normalizeRow(value, input.subjectId, resolveTime)
      canonicalJson(measurement)
      normalized.push({ row: index, measurement })
    }
    catch (error) {
      rejected.set(index, error instanceof ReferenceInputError
        ? { code: error.code, message: error.message }
        : { code: 'INVALID_ROW', message: 'Row does not match the documented reference schema; check fields, types and millisecond timestamps' })
    }
  }
  const byKey = new Map<string, typeof normalized>()
  for (const entry of normalized) {
    const group = byKey.get(entry.measurement.recordKey) ?? []
    group.push(entry)
    byKey.set(entry.measurement.recordKey, group)
  }
  let duplicates = 0
  const measurements: NormalizedMeasurement[] = []
  for (const group of byKey.values()) {
    const fingerprints = new Set(group.map(entry => canonicalJson(entry.measurement)))
    if (fingerprints.size > 1) {
      for (const entry of group) rejected.set(entry.row, { code: 'CONFLICTING_RECORD_KEY', message: 'The same source record key has different measurements in this batch' })
    }
    else {
      measurements.push(group[0].measurement)
      duplicates += group.length - 1
    }
  }
  // Persist all conflicting intervals, but exclude both sides of a conflict.
  // Source priority is never guessed; unknown/generic asleep is never light.
  const stages = measurements.filter(row => row.metric === 'sleep_stages').sort((a, b) => a.startMs - b.startMs)
  let active: NormalizedMeasurement[] = []
  let conflicts = 0
  for (const row of stages) {
    active = active.filter(previous => previous.endMs > row.startMs)
    for (const previous of active) {
      if (row.stage !== previous.stage) {
        conflicts++
        for (const conflicting of [previous, row]) {
          conflicting.scorable = false
          if (!conflicting.exclusions.includes('overlapping_stage_conflict')) conflicting.exclusions.push('overlapping_stage_conflict')
        }
      }
    }
    active.push(row)
  }
  const rejectionCounts: Record<string, number> = {}
  for (const rejection of rejected.values()) rejectionCounts[rejection.code] = (rejectionCounts[rejection.code] ?? 0) + 1
  const warnings = ['Agreement with a reference source is not clinical accuracy.', 'Stage overlaps with conflicting labels are excluded from scoring.']
  if (measurements.some(row => ['hrv_rmssd', 'hrv_sdnn', 'hrv_unknown'].includes(row.metric))) warnings.push('RMSSD, SDNN and unknown HRV definitions cannot directly score the pod window-level IBI variability index.')
  // Hash the exact bounded upload plus interpretation. No arbitrary paths or URLs.
  const uploadJson = JSON.stringify({ adapterVersion: REFERENCE_ADAPTER_VERSION, ...input }, (_key, value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
  return { measurements, uploadJson, summary: {
    adapterVersion: REFERENCE_ADAPTER_VERSION, side: input.side, subjectId: input.subjectId,
    source: input.source, timePolicy: input.timePolicy, received: input.rows.length,
    accepted: measurements.length, rejected: rejected.size, duplicates,
    unscorable: measurements.filter(row => !row.scorable).length, conflicts,
    startMs: measurements.length ? Math.min(...measurements.map(row => row.startMs)) : null,
    endMs: measurements.length ? Math.max(...measurements.map(row => row.endMs)) : null,
    metrics: [...new Set(measurements.map(row => row.metric))].sort(), rejectionCounts,
    rejectionExamples: [...rejected].slice(0, REFERENCE_LIMITS.rejectionExamples).map(([row, error]) => ({ row: row + 1, ...error })), warnings,
  } }
}
