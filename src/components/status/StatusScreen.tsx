'use client'

import { useState, useSyncExternalStore } from 'react'
import { trpc } from '@/src/utils/trpc'
import { HealthCircle, podModelName } from './HealthCircle'
import { WaterModal } from './WaterModal'
import { WaterLevelCard } from './WaterLevelCard'
import { PumpAlertsCard } from './PumpAlertsCard'

const POLL_INTERVAL = 10_000
const noopSubscribe = () => () => {}

type ServiceStatus = 'ok' | 'degraded' | 'error' | 'unknown'

interface ServiceRow {
  name: string
  value: string
  status: ServiceStatus
  detail?: string
}

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms'
  return `${Math.round(ms)}ms`
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function dacMonitorStatus(status?: string): ServiceStatus {
  if (!status) return 'unknown'
  if (status === 'not_initialized') return 'degraded'
  if (status === 'polling' || status === 'connected' || status === 'running') return 'ok'
  if (status === 'error' || status === 'disconnected') return 'error'
  return 'ok'
}

/**
 * All health queries behind the System → Dashboard health ring, plus the
 * derived service rows and the N/N healthy count (React Query dedupes the
 * requests).
 */
export function useStatusSummary() {
  const system = trpc.health.system.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const hardware = trpc.health.hardware.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const dacMonitor = trpc.health.dacMonitor.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const performance = trpc.health.performance.useQuery({}, { refetchInterval: 60_000 })

  const version = trpc.system.getVersion.useQuery({}, { refetchInterval: 60_000 })
  const internet = trpc.system.internetStatus.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const wifi = trpc.system.wifiStatus.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const logSources = trpc.system.getLogSources.useQuery({}, { refetchInterval: 30_000 })
  const storage = trpc.system.getStorageBreakdown.useQuery({}, { refetchInterval: 30_000 })
  const waterLatest = trpc.waterLevel.getLatest.useQuery({}, { refetchInterval: 30_000 })
  const deviceStatus = trpc.device.getStatus.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const calibrationStatus = trpc.calibration.getStatus.useQuery(
    { side: 'left' },
    { refetchInterval: POLL_INTERVAL },
  )

  const drift = system.data?.scheduler?.drift
  const coreServices: ServiceRow[] = [
    {
      name: 'Database',
      value: system.data?.database?.status === 'ok'
        ? formatMs(system.data.database.latencyMs)
        : system.data?.database?.error ?? '—',
      status: system.data?.database?.status ?? 'unknown',
      detail: system.data?.database?.error,
    },
    {
      name: 'System',
      value: system.data ? (system.data.status === 'ok' ? 'all checks passing' : 'degraded') : '—',
      status: system.data?.status ?? 'unknown',
    },
    {
      name: 'Scheduler',
      value: scheduler.data
        ? scheduler.data.enabled
          ? `${scheduler.data.jobCounts?.total ?? 0} jobs${drift ? (drift.drifted ? ' · drifted' : ' · in sync') : ''}`
          : 'disabled'
        : '—',
      status: scheduler.data ? (scheduler.data.healthy ? 'ok' : scheduler.data.enabled ? 'degraded' : 'ok') : 'unknown',
    },
  ]

  const hardwareServices: ServiceRow[] = [
    {
      name: 'DAC socket',
      value: hardware.data?.status === 'ok'
        ? formatMs(hardware.data.latencyMs)
        : hardware.data?.error ?? 'checking…',
      status: hardware.data?.status ?? 'unknown',
      detail: hardware.data?.socketPath,
    },
    {
      name: 'DAC monitor',
      value: dacMonitor.data?.status === 'not_initialized'
        ? 'not initialized'
        : dacMonitor.data?.status ?? 'checking…',
      status: dacMonitorStatus(dacMonitor.data?.status),
    },
  ]

  const calStatus = calibrationStatus.data
  const calibrationServices: ServiceRow[] = (['piezo', 'capacitance', 'temperature'] as const).map((type) => {
    const p = calStatus?.[type]
    return {
      name: type.charAt(0).toUpperCase() + type.slice(1),
      value: p
        ? p.status === 'completed'
          ? p.qualityScore != null ? `${Math.round(p.qualityScore * 100)}%` : '--'
          : p.status
        : 'no data',
      status: p?.status === 'completed'
        ? 'ok'
        : p?.status === 'running' || p?.status === 'pending' ? 'degraded' : 'unknown',
    }
  })

  const networkServices: ServiceRow[] = [
    {
      name: 'Wi-Fi',
      value: wifi.data?.connected
        ? `${wifi.data.ssid ?? 'connected'} · ${wifi.data.signal ?? 0}%`
        : wifi.data ? 'not connected' : '—',
      status: wifi.data ? (wifi.data.connected ? 'ok' : 'degraded') : 'unknown',
    },
    {
      name: 'Internet',
      value: internet.data?.blocked ? 'blocked (local only)' : 'available',
      status: 'ok',
    },
  ]

  const unitServices: ServiceRow[] = (logSources.data?.sources ?? []).map(source => ({
    name: source.name,
    value: source.active ? 'active' : 'inactive',
    status: source.active ? 'ok' : 'degraded',
    detail: source.unit,
  }))

  const allServices = [...coreServices, ...hardwareServices, ...calibrationServices, ...networkServices, ...unitServices]
  const healthy = allServices.filter(s => s.status === 'ok').length

  return {
    healthy,
    total: allServices.length,
    groups: { core: coreServices, hardware: hardwareServices, calibration: calibrationServices, network: networkServices, units: unitServices },
    loading: system.isLoading,
    podName: podModelName(deviceStatus.data?.podVersion ?? dacMonitor.data?.podVersion),
    version: version.data,
    wifi: wifi.data,
    internetBlocked: internet.data?.blocked,
    firewall: system.data?.iptables,
    waterLevel: waterLatest.data?.level ?? deviceStatus.data?.waterLevel,
    diskPercent: storage.data && storage.data.emmc.totalBytes > 0 ? storage.data.emmc.usedPercent : undefined,
    uptimeSeconds: performance.data?.uptimeSeconds,
    updatedAt: system.dataUpdatedAt,
  }
}

/**
 * System → Dashboard header: the N/N health ring with pod facts, pump alerts
 * and water level, plus the water dialog. The detailed service breakdown lives
 * on System → Health.
 */
export function PodStatusSummary() {
  const [waterModalOpen, setWaterModalOpen] = useState(false)
  const s = useStatusSummary()
  const host = useSyncExternalStore(noopSubscribe, () => window.location.hostname, () => '')

  const commit = s.version && s.version.commitHash !== 'unknown' ? s.version.commitHash.slice(0, 7) : null
  const branch = s.version && s.version.branch !== 'unknown' ? s.version.branch : null

  const items = [
    { label: 'Pod', value: s.podName ?? '—' },
    { label: 'Build', value: [branch, commit].filter(Boolean).join(' · ') || '—' },
    {
      label: 'Wi-Fi',
      value: s.wifi ? (s.wifi.connected ? `${s.wifi.ssid ?? 'connected'} · ${s.wifi.signal ?? 0}%` : 'offline') : '—',
    },
    { label: 'Address', value: host || '—' },
    {
      label: 'Water',
      value: s.waterLevel
        ? <span className={s.waterLevel === 'ok' ? 'text-ok' : 'text-warn'}>{s.waterLevel === 'ok' ? 'OK' : 'Low'}</span>
        : '—',
      onClick: () => setWaterModalOpen(true),
    },
    { label: 'Internet', value: s.internetBlocked === undefined ? '—' : s.internetBlocked ? 'Blocked (local)' : 'Allowed' },
    { label: 'Disk', value: s.diskPercent !== undefined ? `${Math.round(s.diskPercent)}% used` : '—' },
    { label: 'Uptime', value: s.uptimeSeconds !== undefined ? formatUptime(s.uptimeSeconds) : '—' },
  ]

  return (
    <>
      <HealthCircle healthy={s.healthy} total={s.total} items={items} />
      <PumpAlertsCard />
      <WaterLevelCard onOpen={() => setWaterModalOpen(true)} />
      <WaterModal open={waterModalOpen} onClose={() => setWaterModalOpen(false)} />
    </>
  )
}
