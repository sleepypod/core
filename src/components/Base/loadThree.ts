import type * as ThreeModule from 'three'

export type Three = typeof ThreeModule

// Pinned to the vendored copy in public/vendor; keep the three versions in step.
export const THREE_SOURCES = [
  'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js',
  'https://unpkg.com/three@0.170.0/build/three.module.min.js',
  // Many pods sit on LANs without internet access.
  '/vendor/three.module.min.js',
] as const
export const THREE_TIMEOUT_MS = 4000

type Importer = (url: string) => Promise<unknown>
// Bundlers must leave these URL imports alone so three.js never enters the shared bundle.
const importUrl: Importer = url => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ url)

const withTimeout = <T>(promise: Promise<T>, ms: number) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)
  promise.then(resolve, reject).finally(() => clearTimeout(timer))
})

const isThree = (loaded: unknown): loaded is Three => typeof (loaded as Three | null)?.WebGLRenderer === 'function'

/** Try each source in order; resolve null when every source fails. */
export async function importThree(load: Importer = importUrl, sources: readonly string[] = THREE_SOURCES): Promise<Three | null> {
  for (const url of sources) {
    try {
      const loaded = await withTimeout(load(url), THREE_TIMEOUT_MS)
      if (isThree(loaded)) return loaded
    }
    catch { /* Fall through to the next source. */ }
  }
  return null
}

let pending: Promise<Three | null> | undefined
export const loadThree = () => pending ??= importThree()

export function hasWebGL() {
  if (typeof window === 'undefined' || typeof WebGLRenderingContext === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  }
  catch {
    return false
  }
}
