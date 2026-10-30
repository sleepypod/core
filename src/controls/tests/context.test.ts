import { describe, expect, it, vi } from 'vitest'
import { withSideLock } from '@/src/hardware/sideLock'
import { beforeControlWrite, ControlDeadlineError, ControlGuardError, outsideControlRequest, withinControlRequest, withinDispatchGuard } from '../context'
import { testScope } from './fixtures'

describe('control dispatch context', () => {
  it('composes nested dispatch guards with durable request checks and rechecks after persistence', async () => {
    const scope = testScope()
    let permitted = true
    const outer = vi.fn()
    const inner = () => {
      if (!permitted) throw new ControlGuardError()
    }
    scope.beforeDispatch = vi.fn(() => {
      permitted = false
    })
    await expect(withinControlRequest(scope, () => withinDispatchGuard(outer,
      () => withinDispatchGuard(inner, async () => beforeControlWrite())))).rejects.toBeInstanceOf(ControlGuardError)
    expect(scope.beforeDispatch).toHaveBeenCalledOnce()
    expect(outer.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(() => beforeControlWrite()).not.toThrow()
  })

  it('closes orphaned policy callbacks but detaches independent schedulers explicitly', async () => {
    const gate = Promise.withResolvers<undefined>()
    let orphan!: Promise<void>, detached!: Promise<void>
    await withinDispatchGuard(() => {}, async () => {
      orphan = gate.promise.then(() => beforeControlWrite())
      detached = outsideControlRequest(() => gate.promise.then(() => beforeControlWrite()))
    })
    const rejected = expect(orphan).rejects.toBeInstanceOf(ControlGuardError)
    gate.resolve(undefined)
    await rejected
    await detached
  })
  it('rechecks expiry after waiting for the side lock', async () => {
    const gate = Promise.withResolvers<undefined>()
    const earlier = withSideLock('left', () => gate.promise)
    const scope = testScope()
    const execute = vi.fn(async () => {})
    const pending = withinControlRequest(scope, () => withSideLock('left', execute))
    const rejected = expect(pending).rejects.toBeInstanceOf(ControlDeadlineError)
    scope.now = () => 200
    gate.resolve(undefined)
    await earlier
    await rejected
    expect(execute).not.toHaveBeenCalled()
    await withSideLock('left', execute)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects orphan callbacks after completion and explicitly detaches independent work', async () => {
    const scope = testScope()
    const gate = Promise.withResolvers<undefined>()
    let orphan!: Promise<void>
    let detached!: Promise<void>
    await withinControlRequest(scope, async () => {
      orphan = gate.promise.then(() => {
        beforeControlWrite()
      })
      detached = outsideControlRequest(() => gate.promise.then(() => {
        beforeControlWrite()
      }))
    })
    const rejected = expect(orphan).rejects.toBeInstanceOf(ControlDeadlineError)
    gate.resolve(undefined)
    await rejected
    await detached
    expect(scope.beforeDispatch).not.toHaveBeenCalled()
  })
})
