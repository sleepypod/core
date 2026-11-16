import { configHash } from './canonical'
import { biometricManifest, resolveOverrides, type Override } from './registry-core'
export { biometricManifest, defaultConfig, validateConfig, removeOverride, legacyStageOverrides, rebaseOverrides } from './registry-core'
export type { BiometricConfig, Override } from './registry-core'

export const manifestHash = configHash(biometricManifest)

/** Resolve against the exact shipped manifest, retaining the canonical identity. */
export function resolveConfig(overrides: Override[], baseHash = manifestHash) {
  if (baseHash !== manifestHash) throw new Error('PROFILE_INCOMPATIBLE: unknown base manifest')
  const result = resolveOverrides(overrides)
  return { ...result, hash: configHash(result.resolved), manifestHash: baseHash }
}
