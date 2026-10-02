import type { AppRouter } from '@/src/server/routers/app'
import { createTRPCClient } from '@trpc/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoLink } from '../link'

const client = () => createTRPCClient<AppRouter>({ links: [demoLink()] })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('demoLink', () => {
  it('answers queries and mutations from the demo handlers', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO', '1')
    const trpc = client()

    await trpc.device.setTemperature.mutate({ side: 'left', temperature: 64 })
    const status = await trpc.device.getStatus.query({ unit: 'F' })

    expect(status.podVersion).toBe('J00')
    expect(status.leftSide.targetTemperature).toBe(64)
  })

  it('surfaces handler errors as tRPC client errors', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO', '1')
    await expect(client().automations.get.query({ id: 987_654 })).rejects.toThrow()
  })

  it('refuses to load the handlers when the demo flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO', '')
    await expect(client().device.getStatus.query({ unit: 'F' })).rejects.toThrow('Demo mode is disabled')
  })

  it('drops the result when the caller unsubscribes first', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO', '1')
    const operation = demoLink()({} as never)
    const op = { id: 1, type: 'query', path: 'device.getStatus', input: { unit: 'F' }, context: {}, signal: null } as const
    const next = vi.fn()
    const error = vi.fn()
    const subscription = operation({ op } as never).subscribe({ next, error })
    subscription.unsubscribe()
    await new Promise(r => setTimeout(r, 300))

    expect(next).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})

describe('resolveDemoCall', () => {
  it('rejects procedures the demo does not implement', async () => {
    const { resolveDemoCall } = await import('../handlers')
    await expect(resolveDemoCall('device.execute', {})).rejects.toThrow('Not available in the demo (device.execute)')
    await expect(resolveDemoCall('nope.nothing', {})).rejects.toThrow('Not available in the demo')
  })
})
