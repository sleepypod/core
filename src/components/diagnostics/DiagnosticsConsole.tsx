'use client'

import { useState } from 'react'
import {
  Activity,
  CalendarClock,
  Cog,
  Cpu,
  Gauge,
  HeartPulse,
  Radio,
  ScrollText,
  Server,
  ServerCog,
  SlidersHorizontal,
} from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { HealthStatusCard } from '@/src/components/status/HealthStatusCard'
import { CalibrationModal } from '@/src/components/status/CalibrationModal'
import { SystemLogViewer } from '@/src/components/status/SystemLogViewer'
import { FirmwareLogConsole } from '@/src/components/Sensors/FirmwareLogConsole'
import { SensorsScreen } from '@/src/components/Sensors/SensorsScreen'

// ── Shared formatting ────────────────────────────────────────────────────────

function fmtF(v: number | null | undefined): string {
  return v == null ? '—' : `${v.toFixed(1)}°F`
}

function fmtAge(sec: number | null | undefined): string {
  if (sec == null) return 'no reading'
  if (sec < 90) return `${sec}s`
  return `${Math.round(sec / 60)}m`
}

function fmtMs(ms: number | undefined): string {
  if (ms == null) return '—'
  if (ms < 1) return '<1ms'
  return `${Math.round(ms)}ms`
}

function fmtRel(iso: string | null): string {
  if (!iso) return '—'
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs < 0) return 'past'
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return '<1m'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const VERDICT_STYLES: Record<string, { label: string, className: string }> = {
  delivering: { label: 'DELIVERING', className: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  idle: { label: 'IDLE', className: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  off: { label: 'OFF', className: 'bg-zinc-600/20 text-zinc-400 ring-zinc-600/30' },
  stalled: { label: 'STALLED', className: 'bg-red-500/20 text-red-300 ring-red-500/40' },
}

type ServiceStatus = 'ok' | 'degraded' | 'error' | 'unknown'

// ── Sections ─────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'thermal', label: 'Thermal', icon: Gauge },
  { id: 'scheduler', label: 'Scheduler', icon: CalendarClock },
  { id: 'health', label: 'Health', icon: ServerCog },
  { id: 'sensors', label: 'Sensors', icon: HeartPulse },
  { id: 'calibration', label: 'Calibration', icon: SlidersHorizontal },
  { id: 'logs', label: 'Logs', icon: ScrollText },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/**
 * Desktop diagnostics console — a maximum-density, full-bleed dashboard that
 * consolidates the pod's diagnostic surfaces (thermal delivery, scheduler,
 * service health, live sensors, calibration, and logs) behind a side-nav.
 *
 * Breaks out of the app's mobile `max-w-md` shell via a full-bleed wrapper so
 * the panels can use the entire viewport. Reached from the desktop-only
 * Diagnostics tab in the bottom nav and from the Status page card.
 */
export function DiagnosticsConsole() {
  const [section, setSection] = useState<SectionId>('overview')

  return (
    <div className="mx-[calc(50%-50vw)] w-screen px-3 sm:px-4">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3 md:flex-row md:gap-4">
        {/* Side-nav — vertical on desktop, horizontal scroller on mobile */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto pb-1 md:w-44 md:flex-col md:overflow-visible md:pb-0">
          {SECTIONS.map((s) => {
            const active = s.id === section
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors md:py-1.5 ${
                  active
                    ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
                    : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                }`}
              >
                <s.icon size={14} className="shrink-0" />
                {s.label}
              </button>
            )
          })}
        </nav>

        {/* Content pane */}
        <div className="min-w-0 flex-1">
          {section === 'overview' && <OverviewPanel onJump={setSection} />}
          {section === 'thermal' && <ThermalPanel />}
          {section === 'scheduler' && <SchedulerPanel />}
          {section === 'health' && <HealthPanel />}
          {section === 'sensors' && <PanelFrame><SensorsScreen /></PanelFrame>}
          {section === 'calibration' && <CalibrationPanel />}
          {section === 'logs' && <LogsPanel />}
        </div>
      </div>
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────

function OverviewPanel({ onJump }: { onJump: (s: SectionId) => void }) {
  const thermal = trpc.health.thermal.useQuery({}, { refetchInterval: 5000 })
  const system = trpc.health.system.useQuery({}, { refetchInterval: 10000 })
  const hardware = trpc.health.hardware.useQuery({}, { refetchInterval: 10000 })
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: 15000 })

  const t = thermal.data
  return (
    <div className="space-y-3">
      <SectionHeader title="Overview" hint={thermal.isFetching ? 'refreshing…' : 'live · 5s'} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Metric label="DB" value={system.data?.database?.status === 'ok' ? fmtMs(system.data.database.latencyMs) : (system.data?.database?.status ?? '—')} good={system.data?.database?.status === 'ok'} />
        <Metric label="DAC socket" value={hardware.data?.status === 'ok' ? fmtMs(hardware.data.latencyMs) : (hardware.data?.status ?? '—')} good={hardware.data?.status === 'ok'} />
        <Metric label="Scheduler" value={scheduler.data?.enabled ? `${scheduler.data.jobCounts?.total ?? 0} jobs` : 'off'} good={scheduler.data?.healthy ?? true} />
        <Metric label="Pump-stall" value={t?.pumpStallProtectionEnabled ? 'armed' : 'opt-in off'} good={!t?.pumpStallProtectionEnabled} />
        <Metric label="Heatsink" value={fmtF(t?.heatsinkTempF)} />
        <Metric label="Ambient" value={fmtF(t?.ambientTempF)} />
      </div>

      {/* Per-side thermal at a glance */}
      <div className="grid gap-2 sm:grid-cols-2">
        {t?.sides.map((s) => {
          const v = VERDICT_STYLES[s.verdict]
          return (
            <button
              key={s.side}
              type="button"
              onClick={() => onJump('thermal')}
              className={`flex items-center justify-between gap-3 rounded-xl bg-zinc-900/80 p-3 text-left ring-1 ${s.verdict === 'stalled' ? 'ring-red-500/40' : 'ring-transparent'}`}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium capitalize text-white">{`${s.side} side`}</p>
                <p className="truncate text-[11px] text-zinc-500">
                  {s.isPowered ? `target ${fmtF(s.targetTempF)} · bed ${fmtF(s.currentTempF)}` : 'off'}
                  {s.pumpRpm != null ? ` · ${s.pumpRpm} rpm` : ''}
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${v?.className ?? ''}`}>{v?.label ?? s.verdict}</span>
            </button>
          )
        })}
      </div>

      {/* Next jobs */}
      <div className="rounded-xl bg-zinc-900/80 p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-xs font-medium text-white">Next scheduled jobs</h3>
          <button type="button" className="text-[11px] text-sky-400" onClick={() => onJump('scheduler')}>all →</button>
        </div>
        <JobList jobs={scheduler.data?.upcomingJobs} limit={6} />
      </div>
    </div>
  )
}

// ── Thermal ──────────────────────────────────────────────────────────────────

function ThermalPanel() {
  const thermal = trpc.health.thermal.useQuery({}, { refetchInterval: 5000 })
  const data = thermal.data

  return (
    <div className="space-y-3">
      <SectionHeader title="Thermal delivery" hint={thermal.isFetching ? 'refreshing…' : 'live · 5s'} />
      {thermal.isLoading && <p className="text-sm text-zinc-400">Loading…</p>}
      {thermal.error && <p className="text-sm text-red-400">{thermal.error.message}</p>}

      {data && (
        <>
          <div className="grid grid-cols-3 gap-2 rounded-xl bg-zinc-900/80 p-3 text-sm">
            <Stat label="Pump-stall protection" value={data.pumpStallProtectionEnabled ? 'ENABLED' : 'disabled'} />
            <Stat label="Heatsink" value={fmtF(data.heatsinkTempF)} />
            <Stat label="Ambient" value={fmtF(data.ambientTempF)} />
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-2">
            {data.sides.map((s) => {
              const v = VERDICT_STYLES[s.verdict]
              const diverged = s.verdict === 'stalled'
              return (
                <div
                  key={s.side}
                  className={`space-y-2.5 rounded-xl bg-zinc-900/80 p-3 ring-1 ${diverged ? 'ring-red-500/40' : 'ring-transparent'}`}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium capitalize text-white">{`${s.side} side`}</h2>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${v?.className ?? ''}`}>{v?.label ?? s.verdict}</span>
                  </div>
                  {s.note && <p className="text-[11px] text-red-300">{s.note}</p>}
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-3">
                    <Stat label="Target" value={s.isPowered ? fmtF(s.targetTempF) : 'off'} />
                    <Stat label="Bed" value={fmtF(s.currentTempF)} />
                    <Stat label="Pump" value={s.pumpRpm == null ? '—' : `${s.pumpRpm} rpm`} />
                    <Stat label="Flow age" value={fmtAge(s.readingAgeSec)} />
                    <Stat label="Water" value={fmtF(s.waterTempF)} />
                    <Stat label="Surface" value={fmtF(s.bedSurfaceTempF)} />
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[10px] text-zinc-400">
                    {s.guardBlocked && <Tag className="bg-red-500/20 text-red-300">guard blocked</Tag>}
                    {s.isAlarmVibrating && <Tag className="bg-amber-500/20 text-amber-300">alarm vibrating</Tag>}
                    {s.poweredOnAt && <span>{`on since ${new Date(s.poweredOnAt).toLocaleTimeString()}`}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Scheduler ────────────────────────────────────────────────────────────────

function SchedulerPanel() {
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: 15000 })
  const system = trpc.health.system.useQuery({}, { refetchInterval: 15000 })
  const counts = scheduler.data?.jobCounts
  const drift = system.data?.scheduler?.drift

  const countEntries: Array<[string, number | undefined]> = [
    ['Total', counts?.total],
    ['Temp', counts?.temperature],
    ['On', counts?.powerOn],
    ['Off', counts?.powerOff],
    ['Alarm', counts?.alarm],
    ['Prime', counts?.prime],
    ['Reboot', counts?.reboot],
  ]

  return (
    <div className="space-y-3">
      <SectionHeader title="Scheduler" hint={scheduler.data?.enabled ? 'enabled' : 'disabled'} />

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        {countEntries.map(([label, value]) => (
          <Metric key={label} label={label} value={value == null ? '—' : String(value)} />
        ))}
      </div>

      {drift && (
        <div className={`rounded-xl p-3 text-xs ${drift.drifted ? 'bg-amber-500/10 text-amber-300' : 'bg-zinc-900/80 text-zinc-400'}`}>
          {drift.drifted
            ? `Drifted: ${drift.dbScheduleCount} DB schedules vs ${drift.schedulerJobCount} active jobs`
            : `In sync · ${drift.dbScheduleCount} schedules`}
        </div>
      )}

      <div className="rounded-xl bg-zinc-900/80 p-3">
        <h3 className="mb-2 text-xs font-medium text-white">Upcoming jobs</h3>
        <JobList jobs={scheduler.data?.upcomingJobs} limit={40} showId />
      </div>
    </div>
  )
}

function JobList({ jobs, limit, showId }: { jobs?: Array<{ id: string, type: string, side?: string, nextRun: string | null }>, limit: number, showId?: boolean }) {
  if (!jobs) return <p className="text-[11px] text-zinc-500">Loading…</p>
  if (jobs.length === 0) return <p className="text-[11px] text-zinc-500">No upcoming jobs</p>
  return (
    <ul className="space-y-1 text-[11px]">
      {jobs.slice(0, limit).map(j => (
        <li key={j.id} className="flex items-center justify-between gap-2 border-b border-zinc-800/50 pb-1 last:border-0">
          <span className="min-w-0 truncate text-zinc-300">
            {j.type}
            {j.side ? <span className="text-zinc-500">{` · ${j.side}`}</span> : ''}
            {showId ? <span className="ml-1 text-zinc-600">{j.id}</span> : ''}
          </span>
          <span className="shrink-0 text-zinc-500">{fmtRel(j.nextRun)}</span>
        </li>
      ))}
    </ul>
  )
}

// ── Health ───────────────────────────────────────────────────────────────────

function HealthPanel() {
  const system = trpc.health.system.useQuery({}, { refetchInterval: 10000 })
  const hardware = trpc.health.hardware.useQuery({}, { refetchInterval: 10000 })
  const dacMonitor = trpc.health.dacMonitor.useQuery({}, { refetchInterval: 10000 })
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: 15000 })
  const wifi = trpc.system.wifiStatus.useQuery({}, { refetchInterval: 10000 })
  const internet = trpc.system.internetStatus.useQuery({}, { refetchInterval: 10000 })
  const logSources = trpc.system.getLogSources.useQuery({}, { refetchInterval: 30000 })

  const coreServices = [
    {
      name: 'Database',
      description: system.data?.database?.status === 'ok' ? `Latency: ${fmtMs(system.data.database.latencyMs)}` : undefined,
      status: (system.data?.database?.status ?? 'unknown') as ServiceStatus,
      detail: system.data?.database?.error,
    },
    {
      name: 'System',
      description: system.data?.status === 'ok' ? 'All checks passing' : 'Degraded',
      status: (system.data?.status ?? 'unknown') as ServiceStatus,
    },
    {
      name: 'Scheduler',
      description: scheduler.data?.enabled ? `Enabled · ${scheduler.data.jobCounts?.total ?? 0} jobs` : 'Disabled',
      status: (scheduler.data?.healthy ? 'ok' : scheduler.data?.enabled ? 'degraded' : 'ok') as ServiceStatus,
    },
  ]

  const hardwareServices = [
    {
      name: 'DAC Socket',
      description: hardware.data?.status === 'ok' ? `Connected · ${fmtMs(hardware.data.latencyMs)}` : hardware.data?.error ?? 'Checking…',
      status: (hardware.data?.status ?? 'unknown') as ServiceStatus,
      detail: hardware.data?.socketPath,
    },
    {
      name: 'DAC Monitor',
      description: dacMonitor.data?.status === 'not_initialized' ? 'Not initialized' : dacMonitor.data?.status ?? 'Checking…',
      status: (dacMonitor.data?.status === 'polling' || dacMonitor.data?.status === 'connected' || dacMonitor.data?.status === 'running'
        ? 'ok'
        : dacMonitor.data?.status === 'error' || dacMonitor.data?.status === 'disconnected'
          ? 'error'
          : dacMonitor.data?.status === 'not_initialized'
            ? 'degraded'
            : 'unknown') as ServiceStatus,
      detail: dacMonitor.data?.podVersion ? `Pod version: ${dacMonitor.data.podVersion}` : undefined,
    },
  ]

  const networkServices = [
    {
      name: 'WiFi',
      description: wifi.data?.connected ? `${wifi.data.ssid ?? 'Connected'} · ${wifi.data.signal ?? 0}%` : 'Not connected',
      status: (wifi.data?.connected ? 'ok' : 'degraded') as ServiceStatus,
    },
    {
      name: 'Internet',
      description: internet.data?.blocked ? 'Blocked (local only)' : 'Available',
      status: 'ok' as ServiceStatus,
    },
  ]

  const systemdServices = (logSources.data?.sources ?? []).map(source => ({
    name: source.name,
    description: source.unit,
    status: (source.active ? 'ok' : 'degraded') as ServiceStatus,
  }))

  return (
    <div className="space-y-3">
      <SectionHeader title="Service health" hint="" />
      <div className="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
        <HealthStatusCard title="Core" description="Server, database, scheduler" icon={Server} iconColor="text-sky-400" iconBg="bg-sky-400/20" services={coreServices} isLoading={system.isLoading} />
        <HealthStatusCard title="Hardware" description="DAC socket and monitoring" icon={Cpu} iconColor="text-purple-400" iconBg="bg-purple-400/20" services={hardwareServices} isLoading={hardware.isLoading || dacMonitor.isLoading} />
        <HealthStatusCard title="Network" description="WiFi and internet" icon={Radio} iconColor="text-teal-400" iconBg="bg-teal-400/20" services={networkServices} isLoading={wifi.isLoading} />
        <HealthStatusCard title="Services" description="Systemd service units" icon={Cog} iconColor="text-cyan-400" iconBg="bg-cyan-400/20" services={systemdServices} isLoading={logSources.isLoading} />
      </div>
    </div>
  )
}

// ── Calibration ──────────────────────────────────────────────────────────────

function CalibrationPanel() {
  const [modalOpen, setModalOpen] = useState(false)
  const cal = trpc.calibration.getStatus.useQuery({ side: 'left' }, { refetchInterval: 10000 })
  const sensors = ['piezo', 'capacitance', 'temperature'] as const
  const data = cal.data

  return (
    <div className="space-y-3">
      <SectionHeader title="Calibration" hint="left side" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {sensors.map((type) => {
          const s = data?.[type]
          const status = s?.status ?? 'unknown'
          const quality = s?.qualityScore != null ? `${Math.round((s.qualityScore as number) * 100)}%` : '—'
          return (
            <div key={type} className="rounded-xl bg-zinc-900/80 p-3">
              <p className="text-xs font-medium capitalize text-white">{type}</p>
              <p className="mt-1 text-[11px] text-zinc-400">
                Status:
                {' '}
                <span className={status === 'completed' ? 'text-emerald-300' : status === 'running' || status === 'pending' ? 'text-amber-300' : 'text-zinc-500'}>{status}</span>
              </p>
              <p className="text-[11px] text-zinc-400">{`Quality: ${quality}`}</p>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="rounded-lg bg-zinc-800/80 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
      >
        Open calibration controls
      </button>
      <CalibrationModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}

// ── Logs ─────────────────────────────────────────────────────────────────────

function LogsPanel() {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <PanelFrame><SystemLogViewer /></PanelFrame>
      <section className="rounded-2xl border border-zinc-800/50 bg-zinc-900/80 p-3">
        <FirmwareLogConsole />
      </section>
    </div>
  )
}

// ── Small shared bits ────────────────────────────────────────────────────────

function SectionHeader({ title, hint }: { title: string, hint: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h1 className="text-base font-semibold text-white">{title}</h1>
      {hint && <span className="text-[11px] text-zinc-500">{hint}</span>}
    </div>
  )
}

function Stat({ label, value }: { label: string, value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="text-zinc-100">{value}</p>
    </div>
  )
}

function Metric({ label, value, good }: { label: string, value: string, good?: boolean }) {
  return (
    <div className="rounded-xl bg-zinc-900/80 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`text-sm font-medium ${good == null ? 'text-zinc-100' : good ? 'text-emerald-300' : 'text-amber-300'}`}>{value}</p>
    </div>
  )
}

function Tag({ children, className }: { children: React.ReactNode, className: string }) {
  return <span className={`rounded px-1.5 py-0.5 ${className}`}>{children}</span>
}

/** Caps an embedded mobile-width screen so it doesn't stretch awkwardly wide. */
function PanelFrame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-2xl xl:mx-0">{children}</div>
}
