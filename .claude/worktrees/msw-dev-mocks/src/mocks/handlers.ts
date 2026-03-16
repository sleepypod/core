import { createTRPCMsw, httpLink } from 'msw-trpc'
import type { AppRouter } from '@/src/server/routers/app'
import { transformer } from '@/src/utils/transformer'
import { PodVersion } from '@/src/hardware/types'

const trpcMsw = createTRPCMsw<AppRouter>({
  links: [httpLink({ url: '/api/trpc' })],
  transformer: transformer as unknown as Parameters<typeof createTRPCMsw>[0]['transformer'],
})

export const handlers = [
  // ── device.getStatus ──────────────────────────────────────────────────────
  trpcMsw.device.getStatus.query(() => ({
    leftSide: {
      currentTemperature: 70,
      targetTemperature: 70,
      currentLevel: -45,
      targetLevel: -45,
      heatingDuration: 0,
    },
    rightSide: {
      currentTemperature: 72,
      targetTemperature: 72,
      currentLevel: -36,
      targetLevel: -36,
      heatingDuration: 0,
    },
    waterLevel: 'ok' as const,
    isPriming: false,
    podVersion: PodVersion.POD_4,
    sensorLabel: 'dev-mock',
    gestures: undefined,
  })),

  // ── device.setTemperature ─────────────────────────────────────────────────
  trpcMsw.device.setTemperature.mutation(() => ({ success: true })),

  // ── device.setPower ───────────────────────────────────────────────────────
  trpcMsw.device.setPower.mutation(() => ({ success: true })),

  // ── device.setAlarm ───────────────────────────────────────────────────────
  trpcMsw.device.setAlarm.mutation(() => ({ success: true })),

  // ── device.clearAlarm ─────────────────────────────────────────────────────
  trpcMsw.device.clearAlarm.mutation(() => ({ success: true })),

  // ── device.startPriming ───────────────────────────────────────────────────
  trpcMsw.device.startPriming.mutation(() => ({ success: true })),

  // ── health.hardware ───────────────────────────────────────────────────────
  trpcMsw.health.hardware.query(() => ({
    status: 'ok' as const,
    socketPath: '/run/dac.sock',
    latencyMs: 2.1,
  })),

  // ── health.dacMonitor ─────────────────────────────────────────────────────
  trpcMsw.health.dacMonitor.query(() => ({
    status: 'running' as const,
    podVersion: PodVersion.POD_4,
    gesturesSupported: false,
  })),

  // ── health.system ─────────────────────────────────────────────────────────
  trpcMsw.health.system.query(() => ({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
    database: {
      status: 'ok' as const,
      latencyMs: 0.5,
    },
    scheduler: {
      enabled: true,
      jobCount: 0,
    },
  })),
]
