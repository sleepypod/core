import contract from '../../../modules/common/biometrics/manifest.v1.json'
import type { StageClassifier } from '@/src/lib/sleep-stage-rules'
import { canonicalJson } from './canonical-json'

interface ParameterSchema {
  type?: string
  properties?: Record<string, ParameterSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: ParameterSchema
  maxItems?: number
  minimum?: number
  maximum?: number
  const?: unknown
  enum?: unknown[]
}

export interface BiometricConfig {
  heart_rate: { trackingToleranceBpm: number, trackingHistoryLength: number, minimumPeakScore: number }
  breathing_rate: { intervalLowerRatio: number, intervalUpperRatio: number }
  hrv_index: { harmonicTolerance: number, minimumWindows: number }
  sleep_stages: StageClassifier
}
export interface Override { path: string, value: unknown }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export const biometricManifest = deepFreeze(contract)
export const defaultConfig = biometricManifest.defaults as BiometricConfig

/** Validated adapters implement this deliberately small shared schema dialect. */
function validateNode(schema: ParameterSchema, value: unknown, path: string): void {
  const fail = (): never => {
    throw new Error(`Invalid biometric parameter: ${path}`)
  }
  if (schema.const !== undefined && value !== schema.const) fail()
  if (schema.enum && !schema.enum.includes(value)) fail()
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
      const record = value as Record<string, unknown>
      const properties = schema.properties ?? {}
      for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) fail()
      for (const [key, child] of Object.entries(record)) {
        if (!Object.hasOwn(properties, key)) fail()
        validateNode(properties[key], child, `${path}.${key}`)
      }
      break
    }
    case 'array':
      if (!Array.isArray(value) || value.length > (schema.maxItems ?? Infinity)) return fail()
      if (!schema.items) throw new Error('Missing array schema')
      for (const child of value) validateNode(schema.items, child, path)
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)
        || (schema.type === 'integer' && !Number.isSafeInteger(value))
        || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail()
      break
    case 'string':
      if (typeof value !== 'string') fail()
      break
    case 'boolean':
      if (typeof value !== 'boolean') fail()
      break
    default: throw new Error(`Unsupported contract schema at ${path}`)
  }
}

function atPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((parent, key) => (parent as Record<string, unknown>)[key], value)
}

export function validateConfig(value: unknown): BiometricConfig {
  canonicalJson(value) // finite JSON, depth/size bounds, no class instances
  validateNode(biometricManifest.parameters, value, 'config')
  for (const path of biometricManifest.orderedRanges) {
    const range = atPath(value, path) as { min: number, max: number }
    if (range.min > range.max) throw new Error(`Invalid ordered range: ${path.join('.')}`)
  }
  return value as BiometricConfig
}

/** Scalars inherit independently; ordered arrays are replaced whole. */
export function resolveOverrides(overrides: Override[]) {
  if (overrides.length > 64) throw new Error('RESOURCE_LIMIT: maximum 64 overrides')
  const resolved = structuredClone(defaultConfig)
  const paths = new Set<string>()
  for (const override of overrides) {
    if (Object.keys(override).some(k => k !== 'path' && k !== 'value')) throw new Error('Unknown override field')
    const parts = override.path.split('.')
    if (paths.has(override.path)) throw new Error('Duplicate override path')
    paths.add(override.path)
    let schema: ParameterSchema = biometricManifest.parameters
    let parent = resolved as unknown as Record<string, unknown>
    for (const [i, part] of parts.entries()) {
      if (schema.type !== 'object' || !schema.properties || !Object.hasOwn(schema.properties, part)) throw new Error(`Unknown override path: ${override.path}`)
      schema = schema.properties[part]
      if (i === parts.length - 1) {
        if (schema.type === 'object') throw new Error('Override leaves or entire ordered arrays')
        validateNode(schema, override.value, override.path)
        parent[part] = structuredClone(override.value)
      }
      else parent = parent[part] as Record<string, unknown>
    }
  }
  validateConfig(resolved)
  return { resolved: deepFreeze(resolved), overrides: structuredClone(overrides), provenance: Object.fromEntries(overrides.map(o => [o.path, 'override' as const])) }
}

/** Removing a path restores inheritance; null is never a removal sentinel. */
export function removeOverride(overrides: Override[], path: string): Override[] {
  return overrides.filter(override => override.path !== path)
}

/** Migrate every legacy leaf, including explicit defaults, to preserve intent. */
export function legacyStageOverrides(classifier: StageClassifier): Override[] {
  const result: Override[] = []
  function walk(value: unknown, path: string) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`)
    }
    else result.push({ path, value })
  }
  walk(classifier, 'sleep_stages')
  resolveOverrides(result)
  return result
}
