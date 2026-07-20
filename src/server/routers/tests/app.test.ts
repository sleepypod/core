import { describe, expect, it } from 'vitest'
import { appRouter } from '@/src/server/routers/app'

describe('appRouter public surface', () => {
  it('answers the unauthenticated healthcheck with the documented sentinel', async () => {
    await expect(appRouter.createCaller({}).healthcheck({})).resolves.toBe('yay!')
  })

  it('publishes the exact healthcheck OpenAPI contract', () => {
    expect(appRouter._def.record.healthcheck._def.meta).toEqual({
      openapi: {
        method: 'GET',
        path: '/healthcheck',
        protect: false,
        tags: ['Health'],
      },
    })
  })

  it('mounts every feature router', () => {
    expect(Object.keys(appRouter._def.record)).toEqual([
      'healthcheck',
      'device',
      'settings',
      'schedules',
      'biometrics',
      'health',
      'system',
      'environment',
      'raw',
      'calibration',
      'waterLevel',
      'pumpAlerts',
      'runOnce',
      'mqtt',
      'homekit',
      'archivePush',
      'automations',
    ])
  })
})
