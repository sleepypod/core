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
  RefreshCw,
  Radio,
  Cog,
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

  // Calibration status for the summary line
  const calibrationStatus = trpc.calibration.getStatus.useQuery(
    { side: 'left' },
    { refetchInterval: 10_000 },
  )

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
      name: 'System',
      description: system.data?.status === 'ok' ? 'All checks passing' : 'Degraded',
      status: (system.data?.status ?? 'unknown') as 'ok' | 'degraded' | 'unknown',
    },
    {
      name: 'Scheduler',
      description: scheduler.data?.enabled
        ? `Enabled \u00b7 ${scheduler.data?.jobCounts?.total ?? 0} jobs`
        : 'Disabled',
      status: (scheduler.data?.healthy ? 'ok' : scheduler.data?.enabled ? 'degraded' : 'ok') as 'ok' | 'degraded',
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

  // Calibration summary for the card
  const calStatus = calibrationStatus.data
  const calSensors = ['piezo', 'capacitance', 'temperature'] as const
  const calCompleted = calSensors.filter(s => calStatus?.[s]?.status === 'completed').length
  const calRunning = calSensors.some(s => calStatus?.[s]?.status === 'running' || calStatus?.[s]?.status === 'pending')

  const calibrationServices = calSensors.map(type => ({
    name: type.charAt(0).toUpperCase() + type.slice(1),
    description: calStatus?.[type]
      ? calStatus[type].status === 'completed'
        ? `Quality: ${calStatus[type].qualityScore != null ? `${Math.round((calStatus[type].qualityScore as number) * 100)}%` : '--'}`
        : calStatus[type].status
      : 'No data',
    status: (calStatus?.[type]?.status === 'completed'
      ? 'ok'
      : calStatus?.[type]?.status === 'running' || calStatus?.[type]?.status === 'pending'
        ? 'degraded'
        : 'unknown') as 'ok' | 'degraded' | 'unknown',
  }))

  // Network — WiFi + Internet only
  const networkServices = [
    {
      name: 'WiFi',
      description: wifi.data?.connected
        ? `${wifi.data.ssid ?? 'Connected'} \u00b7 ${wifi.data.signal ?? 0}%`
        : 'Not connected',
      status: (wifi.data?.connected ? 'ok' : 'degraded') as 'ok' | 'degraded',
    },
    {
      name: 'Internet',
      description: internet.data?.blocked ? 'Blocked (local only)' : 'Available',
      status: 'ok' as const,
    },
  ]

  // Systemd service units (separate card matching iOS)
  const systemdServices = (logSources.data?.sources ?? []).map(source => ({
    name: source.name,
    description: source.unit,
    status: (source.active ? 'ok' : 'degraded') as 'ok' | 'degraded',
  }))

  // Scheduler expanded content
  const jobCounts = scheduler.data?.jobCounts
  const drift = system.data?.scheduler?.drift
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
            {jobCounts.temperature > 0 && (
              <span className="text-zinc-300">
                Temp:
                {jobCounts.temperature}
              </span>
            )}
            {jobCounts.powerOn > 0 && (
              <span className="text-zinc-300">
                On:
                {jobCounts.powerOn}
              </span>
            )}
            {jobCounts.powerOff > 0 && (
              <span className="text-zinc-300">
                Off:
                {jobCounts.powerOff}
              </span>
            )}
            {jobCounts.alarm > 0 && (
              <span className="text-zinc-300">
                Alarm:
                {jobCounts.alarm}
              </span>
            )}
            {jobCounts.prime > 0 && (
              <span className="text-zinc-300">
                Prime:
                {jobCounts.prime}
              </span>
            )}
            {jobCounts.reboot > 0 && (
              <span className="text-zinc-300">
                Reboot:
                {jobCounts.reboot}
              </span>
            )}
          </div>
        </div>
      )}
      {drift && (
        <div className="text-xs text-zinc-400">
          {drift.drifted
            ? `Drifted: ${drift.dbScheduleCount} DB vs ${drift.schedulerJobCount} active`
            : `In sync \u00b7 ${drift.dbScheduleCount} schedules`}
        </div>
      )}
      {upcomingJobs && upcomingJobs.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-zinc-400">Upcoming Jobs</p>
          {upcomingJobs.slice(0, 5).map(job => (
            <div key={job.id} className="flex items-center justify-between text-xs">
              <span className="text-zinc-300">
                {job.type}
                {job.side && (
                  <span className="ml-1 text-zinc-500">
                    (
                    {job.side}
                    )
                  </span>
                )}
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

  const allServices = [...coreServices, ...hardwareServices, ...calibrationServices, ...networkServices, ...systemdServices]
  const totalHealthy = allServices.filter(s => s.status === 'ok').length
  const totalServices = allServices.length

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <div className="space-y-3">
        <HealthCircle
          healthy={totalHealthy}
          total={totalServices}
          podVersion={dacMonitor.data?.podVersion}
          sensorLabel={deviceStatus.data?.sensorLabel ?? undefined}
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
        />

        {/* System info — branch/commit/build date + full disk usage */}
        <SystemInfoCard />

        {/* Internet access toggle */}
        <InternetToggleCard />

        {/* ── Core ── */}
        <HealthStatusCard
          title="Core"
          description="Server, database, and scheduler"
          icon={Server}
          iconColor="text-sky-400"
          iconBg="bg-sky-400/20"
          services={coreServices}
          isLoading={system.isLoading}
          expandedContent={schedulerExpandedContent}
        />

        {/* ── Hardware ── */}
        <HealthStatusCard
          title="Hardware"
          description="DAC socket and monitoring"
          icon={Cpu}
          iconColor="text-purple-400"
          iconBg="bg-purple-400/20"
          services={hardwareServices}
          isLoading={hardware.isLoading || dacMonitor.isLoading}
        />

        {/* ── Calibration ── */}
        <HealthStatusCard
          title="Calibration"
          description={calRunning ? 'Running...' : `${calCompleted}/3 sensors calibrated`}
          icon={RefreshCw}
          iconColor="text-orange-400"
          iconBg="bg-orange-400/20"
          services={calibrationServices}
          isLoading={calibrationStatus.isLoading}
          onHeaderClick={() => setCalibrationModalOpen(true)}
        />

        {/* ── Network ── */}
        <HealthStatusCard
          title="Network"
          description="WiFi and internet connectivity"
          icon={Radio}
          iconColor="text-teal-400"
          iconBg="bg-teal-400/20"
          services={networkServices}
          isLoading={wifi.isLoading}
        />

        {/* ── Services ── */}
        <HealthStatusCard
          title="Services"
          description="Systemd service units"
          icon={Cog}
          iconColor="text-cyan-400"
          iconBg="bg-cyan-400/20"
          services={systemdServices}
          isLoading={logSources.isLoading}
        />

        {/* Software update */}
        <UpdateCard />

        {/* System log viewer — journalctl browser */}
        <SystemLogViewer />

        {/* Firmware Console — wrapped in a card (header is internal) */}
        <section className="rounded-2xl border border-zinc-800/50 bg-zinc-900/80 p-3 sm:p-4">
          <FirmwareLogConsole />
        </section>

        {system.dataUpdatedAt && (
          <p className="text-center text-xs text-zinc-600">
            Last updated:
            {' '}
            {new Date(system.dataUpdatedAt).toLocaleTimeString()}
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
