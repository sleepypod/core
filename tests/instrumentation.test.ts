/**
 * Gate behavior for the Next.js `register()` instrumentation hook.
 *
 * The hook fires once per server bundle (Node + Edge), so we must skip the
 * non-Node runtime to avoid double-initializing services that are not
 * idempotent — most visibly the MQTT bridge, which would open two client
 * connections from one pod process.
 */

import { describe, expect, it } from 'vitest'
import { shouldRunInstrumentation } from '../instrumentation'

describe('shouldRunInstrumentation', () => {
  it('runs when NEXT_RUNTIME is unset (test/script context)', () => {
    expect(shouldRunInstrumentation({})).toBe(true)
  })

  it('runs when NEXT_RUNTIME=nodejs (production node bundle)', () => {
    expect(shouldRunInstrumentation({ NEXT_RUNTIME: 'nodejs' })).toBe(true)
  })

  it('skips when NEXT_RUNTIME=edge (avoids duplicate bridge init)', () => {
    expect(shouldRunInstrumentation({ NEXT_RUNTIME: 'edge' })).toBe(false)
  })

  it('skips for any non-nodejs runtime value', () => {
    expect(shouldRunInstrumentation({ NEXT_RUNTIME: 'experimental-edge' })).toBe(false)
    expect(shouldRunInstrumentation({ NEXT_RUNTIME: 'workerd' })).toBe(false)
  })
})
