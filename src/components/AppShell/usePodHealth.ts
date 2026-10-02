'use client'

import { attentionItems } from '@/src/components/diagnostics/dashboardLogic'
import { useNowMinute } from '@/src/components/Schedule/CurveChart'
import { trpc } from '@/src/utils/trpc'
import { footerStatus } from './footerStatus'

/**
 * The pod's health as the navigation shows it: failing system checks plus the
 * System Dashboard's attention items. Shared by the sidebar footer and the
 * phone tab bar's System dot.
 */
export function usePodHealth() {
  const status = trpc.device.getStatus.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const health = trpc.health.system.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const maintenance = trpc.health.maintenance.useQuery({}, { staleTime: 30_000, refetchInterval: 60_000 })
  const water = trpc.waterLevel.getLatest.useQuery({}, { staleTime: 10_000, refetchInterval: 30_000 })
  const nowMinute = useNowMinute()
  const attention = nowMinute == null
    ? []
    : attentionItems(maintenance.data, water.data?.level ?? status.data?.waterLevel, nowMinute * 60_000)
  return { footer: footerStatus(health.data, attention), podVersion: status.data?.podVersion }
}
