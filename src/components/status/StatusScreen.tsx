'use client'

import { useCallback, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { PullToRefresh } from '@/src/components/PullToRefresh/PullToRefresh'
import { HealthCircle } from './HealthCircle'
import { HealthStatusCard } from './HealthStatusCard'
import { SystemInfoCard } from './SystemInfoCard'
import { UpdateCard } from './UpdateCard'
import { WaterModal } from './WaterModal'
import { CalibrationModal } from './CalibrationModal'
import { InternetToggleCard } from './InternetToggleCard'
import { SystemLogViewer } from './SystemLogViewer'
import { FirmwareLogConsole } from '@/src/components/Sensors/FirmwareLogConsole'
import {
  Server,
  Cpu,
  Calendar,
  Activity,
} from 'lucide-react'

const POLL_INTERVAL = 10_000

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms'
  return `${Math.round(ms)}ms`
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  return `${gb.toFixed(1)} GB`
}

function dacMonitorStatus(status?: string): 'ok' | 'degraded' | 'error' | 'unknown' {
  if (!status) return 'unknown'
  if (status === 'not_initialized') return 'degraded'
  if (status === 'polling' || status === 'connected' || status === 'running') return 'ok'
  if (status === 'error' || status === 'disconnected') return 'error'
  return 'ok'
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()

  if (diffMs < 0) return 'past'

  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return '<1m'
  if (diffMin < 60) return `${diffMin}m`

  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ${diffMin % 60}m`

  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ${diffHours % 24}h`
}

export function StatusScreen() {
  const [waterModalOpen, setWaterModalOpen] = useState(false)
  const [calibrationModalOpen, setCalibrationModalOpen] = useState(false)

  // Health endpoints — poll every 10s
  const system = trpc.health.system.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const hardware = trpc.health.hardware.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const dacMonitor = trpc.health.dacMonitor.useQuery({}, { refetchInterval: POLL_INTERVAL })

  // System info — less frequent
  const version = trpc.system.getVersion.useQuery({}, { refetchInterval: 60_000 })
  const disk = trpc.system.getDiskUsage.useQuery({}, { refetchInterval: 30_000 })
  const internet = trpc.system.internetStatus.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const wifi = trpc.system.wifiStatus.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const logSources = trpc.system.getLogSources.useQuery({}, { refetchInterval: 30_000 })
  const waterLatest = trpc.waterLevel.getLatest.useQuery({}, { refetchInterval: 30_000 })
  const deviceStatus = trpc.device.getStatus.useQuery({}, { refetchInterval: 10_000 })

  const utils = trpc.useUtils()

  /** Pull-to-refresh: refetch all status queries. */
  const handleRefresh = useCallback(async () => {
    await Promise.all([
      utils.health.system.invalidate(),
      utils.health.hardware.invalidate(),
      utils.health.scheduler.invalidate(),
      utils.health.dacMonitor.invalidate(),
      utils.system.getVersion.invalidate(),
      utils.system.getDiskUsage.invalidate(),
      utils.system.internetStatus.invalidate(),
      utils.system.wifiStatus.invalidate(),
      utils.system.getLogSources.invalidate(),
      utils.waterLevel.getLatest.invalidate(),
      utils.waterLevel.getAlerts.invalidate(),
    ])
  }, [utils])

  // ─── Build service lists ──────────────────────────────────────────

  const coreServices = [
    {
      name: 'Database',
      description: system.data?.database?.status === 'ok'
        ? `Latency: ${formatMs(system.data.database.latencyMs)}`
        : undefined,
      status: (system.data?.database?.status ?? 'unknown') as 'ok' | 'degraded' | 'unknown',
      detail: system.data?.database?.error,
    },
    {
      name: 'WiFi',
      description: wifi.data?.connected
        ? `${wifi.data.ssid ?? 'Connected'} \u00b7 ${wifi.data.signal ?? 0}%`
        : 'Not connected',
      status: (wifi.data?.connected ? 'ok' : 'degraded') as 'ok' | 'degraded',
    },
    {
      name: 'System',
      description: system.data?.status === 'ok' ? 'All checks passing' : 'Degraded',
      status: (system.data?.status ?? 'unknown') as 'ok' | 'degraded' | 'unknown',
    },
  ]

  const hardwareServices = [
    {
      name: 'DAC Socket',
      description: hardware.data?.status === 'ok'
        ? `Connected \u00b7 ${formatMs(hardware.data.latencyMs)}`
        : hardware.data?.error ?? 'Checking\u2026',
      status: (hardware.data?.status ?? 'unknown') as 'ok' | 'degraded' | 'unknown',
      detail: hardware.data?.socketPath,
    },
    {
      name: 'DAC Monitor',
      description: dacMonitor.data?.status === 'not_initialized'
        ? 'Not initialized'
        : dacMonitor.data?.status ?? 'Checking\u2026',
      status: dacMonitorStatus(dacMonitor.data?.status),
      detail: dacMonitor.data?.podVersion
        ? `Pod version: ${dacMonitor.data.podVersion}`
        : undefined,
    },
  ]

  const schedulerEnabled = scheduler.data?.enabled ?? false
  const jobCounts = scheduler.data?.jobCounts
  const drift = system.data?.scheduler?.drift

  const schedulerServices = [
    {
      name: 'Scheduler',
      description: schedulerEnabled
        ? `Enabled \u00b7 ${jobCounts?.total ?? 0} jobs`
        : 'Disabled',
      status: (scheduler.data?.healthy ? 'ok' : schedulerEnabled ? 'degraded' : 'ok') as 'ok' | 'degraded',
    },
    ...(drift ? [{
      name: 'Schedule Sync',
      description: drift.drifted
        ? `Drifted: ${drift.dbScheduleCount} DB vs ${drift.schedulerJobCount} active`
        : `In sync \u00b7 ${drift.dbScheduleCount} schedules`,
      status: (drift.drifted ? 'degraded' : 'ok') as 'ok' | 'degraded',
    }] : []),
  ]

  const systemdServices = (logSources.data?.sources ?? []).map(source => ({
    name: source.name,
    description: source.unit,
    status: (source.active ? 'ok' : 'degraded') as 'ok' | 'degraded',
  }))

  // Upcoming jobs for scheduler expanded view
  const upcomingJobs = scheduler.data?.upcomingJobs as Array<{
    id: string
    type: string
    side?: string
    nextRun: string | null
  }> | undefined

  const schedulerExpandedContent = (
    <div className="space-y-3">
      {jobCounts && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-zinc-400">Job Breakdown</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3 sm:gap-x-4">
            {jobCounts.temperature > 0 && <span className="text-zinc-300">Temp: {jobCounts.temperature}</span>}
            {jobCounts.powerOn > 0 && <span className="text-zinc-300">On: {jobCounts.powerOn}</span>}
            {jobCounts.powerOff > 0 && <span className="text-zinc-300">Off: {jobCounts.powerOff}</span>}
            {jobCounts.alarm > 0 && <span className="text-zinc-300">Alarm: {jobCounts.alarm}</span>}
            {jobCounts.prime > 0 && <span className="text-zinc-300">Prime: {jobCounts.prime}</span>}
            {jobCounts.reboot > 0 && <span className="text-zinc-300">Reboot: {jobCounts.reboot}</span>}
          </div>
        </div>
      )}
      {upcomingJobs && upcomingJobs.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-zinc-400">Upcoming Jobs</p>
          {upcomingJobs.slice(0, 5).map((job) => (
            <div key={job.id} className="flex items-center justify-between text-xs">
              <span className="text-zinc-300">
                {job.type}
                {job.side && <span className="ml-1 text-zinc-500">({job.side})</span>}
              </span>
              <span className="text-zinc-500">
                {job.nextRun ? formatRelativeTime(job.nextRun) : '\u2014'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  // ─── Aggregate totals ─────────────────────────────────────────────

  const allServices = [...coreServices, ...hardwareServices, ...schedulerServices, ...systemdServices]
  const totalHealthy = allServices.filter(s => s.status === 'ok').length
  const totalServices = allServices.length

  return (
    <PullToRefresh onRefresh={handleRefresh}>
    <div className="space-y-3">
      <HealthCircle
        healthy={totalHealthy}
        total={totalServices}
        podVersion={dacMonitor.data?.podVersion}
        branch={version.data?.branch}
        commitHash={version.data?.commitHash}
        diskPercent={disk.data?.usedPercent}
        diskLabel={
          disk.data && disk.data.totalBytes > 0
            ? `${formatBytes(disk.data.usedBytes)} / ${formatBytes(disk.data.totalBytes)}`
            : undefined
        }
        internetBlocked={internet.data?.blocked}
        wifiSsid={wifi.data?.ssid ?? undefined}
        wifiSignal={wifi.data?.signal ?? undefined}
        podIP={typeof window !== 'undefined' ? window.location.hostname : undefined}
        waterLevel={waterLatest.data?.level ?? undefined}
        isPriming={deviceStatus.data?.isPriming ?? false}
        onWaterClick={() => setWaterModalOpen(true)}
        onCalibrationClick={() => setCalibrationModalOpen(true)}
      />

      {/* Internet access toggle — above service cards */}
      <InternetToggleCard />

      <HealthStatusCard
        title="Core"
        description="Server, database, and WiFi"
        icon={Server}
        iconColor="text-sky-400"
        iconBg="bg-sky-400/20"
        services={coreServices}
        isLoading={system.isLoading || wifi.isLoading}
      />

      <HealthStatusCard
        title="Hardware"
        description="DAC socket and monitoring"
        icon={Cpu}
        iconColor="text-purple-400"
        iconBg="bg-purple-400/20"
        services={hardwareServices}
        isLoading={hardware.isLoading || dacMonitor.isLoading}
      />

      <HealthStatusCard
        title="Schedules"
        description="Temperature, power, and alarm jobs"
        icon={Calendar}
        iconColor="text-amber-400"
        iconBg="bg-amber-400/20"
        services={schedulerServices}
        isLoading={scheduler.isLoading}
        expandedContent={schedulerExpandedContent}
      />

      {systemdServices.length > 0 && (
        <HealthStatusCard
          title="Services"
          description="Systemd service units"
          icon={Activity}
          iconColor="text-teal-400"
          iconBg="bg-teal-400/20"
          services={systemdServices}
          isLoading={logSources.isLoading}
        />
      )}

      {/* Software update */}
      <UpdateCard />

      {/* System log viewer — journalctl browser */}
      <SystemLogViewer />

      {/* Firmware Console */}
      <FirmwareLogConsole />

      {system.dataUpdatedAt && (
        <p className="text-center text-xs text-zinc-600">
          Last updated: {new Date(system.dataUpdatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>

    {/* Water + Priming modal */}
    <WaterModal open={waterModalOpen} onClose={() => setWaterModalOpen(false)} />

    {/* Calibration modal */}
    <CalibrationModal open={calibrationModalOpen} onClose={() => setCalibrationModalOpen(false)} />

    </PullToRefresh>
  )
}
