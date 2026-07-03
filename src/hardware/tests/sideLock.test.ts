/**
 * Tests for withSideLock — per-side hardware write serialization.
 *
 * The lock map must live on globalThis: Turbopack can duplicate the module
 * across chunks, and per-chunk maps would silently stop serializing writes
 * between components (scheduler vs automation engine).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withSideLock } from '../sideLock'

const G = globalThis as Record<string, unknown>
const SIDE_LOCKS_KEY = '__sp_side_locks__'

afterEach(() => {
  delete G[SIDE_LOCKS_KEY]
})

describe('withSideLock', () => {
  it('serializes writers for the same side', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })

    const p1 = withSideLock('left', async () => {
      order.push('first-start')
      await gate
      order.push('first-end')
    })
    const p2 = withSideLock('left', async () => {
      order.push('second')
    })

    await new Promise(r => setTimeout(r, 10))
    expect(order).toEqual(['first-start'])

    release()
    await Promise.all([p1, p2])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('does not block writers on the other side', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })

    const p1 = withSideLock('left', async () => {
      await gate
      order.push('left')
    })
    const p2 = withSideLock('right', async () => {
      order.push('right')
    })

    await p2
    expect(order).toEqual(['right'])
    release()
    await p1
  })

  it('releases the lock when the writer throws', async () => {
    await expect(withSideLock('left', async () => {
      throw new Error('write failed')
    })).rejects.toThrow('write failed')

    // Next writer must not deadlock
    const result = await withSideLock('left', async () => 'ok')
    expect(result).toBe('ok')
  })

  it('shares one lock map across duplicated module instances (globalThis-backed)', async () => {
    vi.resetModules()
    const duplicate = await import('../sideLock')
    expect(duplicate.withSideLock).not.toBe(withSideLock)

    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })

    // Lock taken through the original module instance...
    const p1 = withSideLock('left', async () => {
      order.push('original-start')
      await gate
      order.push('original-end')
    })
    // ...must block a writer entering through the duplicated instance.
    const p2 = duplicate.withSideLock('left', async () => {
      order.push('duplicate')
    })

    await new Promise(r => setTimeout(r, 10))
    expect(order).toEqual(['original-start'])

    release()
    await Promise.all([p1, p2])
    expect(order).toEqual(['original-start', 'original-end', 'duplicate'])
  })
})
