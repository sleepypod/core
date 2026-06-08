'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  CalendarClock,
  Clipboard,
  ClipboardCheck,
  Cog,
  Cpu,
  Gauge,
  HeartPulse,
  Loader2,
  Radio,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  SlidersHorizontal,
  Wand2,
} from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { DataTable, type Column } from '@/src/ui/data-table'
import { useTrendBuffer } from '@/src/hooks/useTrendBuffer'
import { ThermalTrendChart } from '@/src/components/diagnostics/ThermalTrendChart'
import { BiometricsTrendChart } from '@/src/components/diagnostics/BiometricsTrendChart'
import {
  fmtF, fmtAge, fmtMs, fmtNum, fmtRel, fmtClock, fmtDayLabel,
  VERDICT_STYLES, buildWeekLanes, jobTone, fmtJobValue, biometricsFlowStatus, thermalTrendPoints,
  type SchedJob,
} from '@/src/components/diagnostics/diagnosticsLogic'
import { HealthStatusCard } from '@/src/components/status/HealthStatusCard'
import { SystemInfoCard } from '@/src/components/status/SystemInfoCard'
import { InternetToggleCard } from '@/src/components/status/InternetToggleCard'
import { UpdateCard } from '@/src/components/status/UpdateCard'
import { SystemLogViewer } from '@/src/components/status/SystemLogViewer'
import { FirmwareLogConsole } from '@/src/components/Sensors/FirmwareLogConsole'
import { SensorsScreen } from '@/src/components/Sensors/SensorsScreen'

// Formatting, scheduler-lane, and biometrics/thermal derivations live in
// ./diagnosticsLogic so they can be unit-tested without React/tRPC.

type ServiceStatus = 'ok' | 'degraded' | 'error' | 'unknown'

// ── Sections ─────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'thermal', label: 'Thermal', icon: Gauge },
  { id: 'scheduler', label: 'Scheduler', icon: CalendarClock },
  { id: 'biometrics', label: 'Biometrics', icon: HeartPulse },
  { id: 'sensors', label: 'Sensors', icon: Radio },
  { id: 'health', label: 'Health', icon: ServerCog },
  { id: 'calibration', label: 'Calibration', icon: SlidersHorizontal },
  { id: 'automations', label: 'Automations', icon: Wand2 },
  { id: 'logs', label: 'Logs', icon: ScrollText },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/**
 * Desktop diagnostics console — a maximum-density, full-bleed dashboard that
 * consolidates the pod's diagnostic surfaces (thermal delivery, scheduler,
 * service health, biometrics, calibration, and logs) behind a side-nav.
 *
 * Breaks out of the app's mobile `max-w-md` shell via a full-bleed wrapper so
 * the panels can use the full viewport. Desktop-first: the side-nav also hosts
 * the active side and Settings, which the header drops on wide viewports.
 */
export function DiagnosticsConsole() {
  const [section, setSection] = useState<SectionId>('overview')
  const { side } = useSide()
  const { sideName } = useSideNames()
  const pathname = usePathname()
  const lang = pathname?.split('/')[1] ?? 'en'

  return (
    <div className="mx-[calc(50%-50vw)] w-screen px-4">
      <div className="mx-auto flex max-w-[1700px] gap-4">
        {/* Side-nav */}
        <nav className="flex w-44 shrink-0 flex-col gap-1">
          {SECTIONS.map((s) => {
            const active = s.id === section
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
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

          <div className="mt-auto space-y-1 border-t border-zinc-800/60 pt-2">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-zinc-600">
              {`Active side · ${sideName(side)}`}
            </div>
            <Link
              href={`/${lang}/settings`}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
            >
              <Settings size={14} className="shrink-0" />
              Settings
            </Link>
          </div>
        </nav>

        {/* Content pane */}
        <div className="min-w-0 flex-1 pb-6">
          {section === 'overview' && <OverviewPanel onJump={setSection} />}
          {section === 'thermal' && <ThermalPanel />}
          {section === 'scheduler' && <SchedulerPanel />}
          {section === 'biometrics' && <BiometricsPanel />}
          {section === 'sensors' && <SensorsPanel />}
          {section === 'health' && <HealthPanel />}
          {section === 'calibration' && <CalibrationPanel />}
          {section === 'automations' && <AutomationsPanel />}
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

      <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
        <Metric label="DB" value={system.data?.database?.status === 'ok' ? fmtMs(system.data.database.latencyMs) : (system.data?.database?.status ?? '—')} good={system.data?.database?.status === 'ok'} />
        <Metric label="DAC socket" value={hardware.data?.status === 'ok' ? fmtMs(hardware.data.latencyMs) : (hardware.data?.status ?? '—')} good={hardware.data?.status === 'ok'} />
        <Metric label="Scheduler" value={scheduler.data?.enabled ? `${scheduler.data.jobCounts?.total ?? 0} jobs` : 'off'} good={scheduler.data?.healthy ?? true} />
        <Metric label="Pump-stall" value={t?.pumpStallProtectionEnabled ? 'armed' : 'opt-in off'} good={!t?.pumpStallProtectionEnabled} />
        <Metric label="Heatsink" value={fmtF(t?.heatsinkTempF)} />
        <Metric label="Ambient" value={fmtF(t?.ambientTempF)} />
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
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

function JobList({ jobs, limit }: { jobs?: Array<{ id: string, type: string, side?: string, nextRun: string | null }>, limit: number }) {
  if (!jobs) return <p className="text-[11px] text-zinc-500">Loading…</p>
  if (jobs.length === 0) return <p className="text-[11px] text-zinc-500">No upcoming jobs</p>
  return (
    <ul className="space-y-1 text-[11px]">
      {jobs.slice(0, limit).map(j => (
        <li key={j.id} className="flex items-center justify-between gap-2 border-b border-zinc-800/50 pb-1 last:border-0">
          <span className="min-w-0 truncate text-zinc-300">
            {j.type}
            {j.side ? <span className="text-zinc-500">{` · ${j.side}`}</span> : ''}
          </span>
          <span className="shrink-0 text-zinc-500">{fmtRel(j.nextRun)}</span>
        </li>
      ))}
    </ul>
  )
}

// ── Thermal ──────────────────────────────────────────────────────────────────

function ThermalPanel() {
  const thermal = trpc.health.thermal.useQuery({}, { refetchInterval: 5000 })
  const data = thermal.data
  const history = useTrendBuffer(data, thermal.dataUpdatedAt)

  return (
    <div className="space-y-3">
      <SectionHeader title="Thermal delivery" hint={thermal.isFetching ? 'refreshing…' : 'live · 5s'} />
      {thermal.isLoading && <p className="text-sm text-zinc-400">Loading…</p>}
      {thermal.error && <p className="text-sm text-red-400">{thermal.error.message}</p>}

      {data && (
        <>
          <div className="grid grid-cols-3 gap-2 rounded-xl bg-zinc-900/80 p-3 text-sm xl:max-w-2xl">
            <Stat label="Pump-stall protection" value={data.pumpStallProtectionEnabled ? 'ENABLED' : 'disabled'} />
            <Stat label="Heatsink" value={fmtF(data.heatsinkTempF)} />
            <Stat label="Ambient" value={fmtF(data.ambientTempF)} />
          </div>

          <div className="grid gap-2 lg:grid-cols-2">
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
                  <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
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
                  <ThermalTrendChart side={s.side as 'left' | 'right'} points={thermalTrendPoints(history, s.side)} />
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

/** 7-day lane view: one row per day, jobs as time-ordered chips. Detail lives in the table below. */
function SchedulerWeek({ jobs }: { jobs: SchedJob[] }) {
  const lanes = useMemo(() => buildWeekLanes(jobs), [jobs])
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800/60">
      {lanes.map((lane) => {
        const { weekday, day } = fmtDayLabel(lane.date)
        return (
          <div key={lane.date} className={`flex items-stretch gap-3 border-b border-zinc-800/40 px-3 py-2 last:border-b-0 ${lane.isToday ? 'bg-zinc-800/30' : ''}`}>
            <div className="w-16 shrink-0 pt-0.5">
              <p className={`text-xs font-medium ${lane.isToday ? 'text-white' : 'text-zinc-300'}`}>{lane.isToday ? 'Today' : weekday}</p>
              <p className="text-[10px] text-zinc-500">{day}</p>
            </div>
            <div className="flex min-h-[1.5rem] flex-1 flex-wrap items-center gap-1.5">
              {lane.jobs.length === 0
                ? <span className="text-[11px] text-zinc-600">—</span>
                : lane.jobs.map(j => (
                    <span key={j.id} className={`rounded px-1.5 py-0.5 text-[10px] ${jobTone(j.type)}`} title={`${j.type}${j.side ? ` · ${j.side}` : ''}${fmtJobValue(j) === '—' ? '' : ` · ${fmtJobValue(j)}`}`}>
                      {`${fmtClock(j.nextRun)} ${j.type}${j.side ? ` · ${j.side[0].toUpperCase()}` : ''}${fmtJobValue(j) === '—' ? '' : ` ${fmtJobValue(j)}`}`}
                    </span>
                  ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SchedulerPanel() {
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: 15000 })
  const system = trpc.health.system.useQuery({}, { refetchInterval: 15000 })
  const counts = scheduler.data?.jobCounts
  const drift = system.data?.scheduler?.drift
  const jobs = (scheduler.data?.upcomingJobs ?? []) as SchedJob[]

  const countEntries: Array<[string, number | undefined]> = [
    ['Total', counts?.total],
    ['Temp', counts?.temperature],
    ['On', counts?.powerOn],
    ['Off', counts?.powerOff],
    ['Alarm', counts?.alarm],
    ['Prime', counts?.prime],
    ['Reboot', counts?.reboot],
  ]

  const columns: Array<Column<SchedJob>> = [
    { key: 'type', header: 'Type', render: r => <span className="font-medium text-zinc-200">{r.type}</span>, sortValue: r => r.type },
    { key: 'side', header: 'Side', render: r => <span className="capitalize text-zinc-400">{r.side ?? '—'}</span>, sortValue: r => r.side ?? '' },
    { key: 'value', header: 'Value', align: 'right', render: r => <span className="text-zinc-300">{fmtJobValue(r)}</span>, sortValue: r => r.targetTempF ?? r.brightness ?? -1 },
    { key: 'nextRun', header: 'Next run', render: r => <span className="text-zinc-300">{r.nextRun ? new Date(r.nextRun).toLocaleString() : '—'}</span>, sortValue: r => r.nextRun ?? '' },
    { key: 'in', header: 'In', align: 'right', render: r => <span className="text-zinc-400">{fmtRel(r.nextRun)}</span>, sortValue: r => (r.nextRun ? new Date(r.nextRun).getTime() : Number.MAX_SAFE_INTEGER) },
    { key: 'id', header: 'Job ID', render: r => <span className="font-mono text-[10px] text-zinc-600">{r.id}</span>, sortValue: r => r.id },
  ]

  return (
    <div className="space-y-3">
      <SectionHeader title="Scheduler" hint={scheduler.data?.enabled ? 'enabled' : 'disabled'} />

      <div className="grid grid-cols-4 gap-2 xl:grid-cols-7">
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

      <SchedulerWeek jobs={jobs} />

      <DataTable
        columns={columns}
        rows={jobs}
        getRowKey={r => r.id}
        empty={scheduler.isLoading ? 'Loading…' : 'No upcoming jobs'}
      />
    </div>
  )
}

// ── Biometrics ───────────────────────────────────────────────────────────────

interface VitalRow { side: string, timestamp: Date, heartRate: number | null, hrv: number | null, breathingRate: number | null }

function BiometricsPanel() {
  const { side } = useSide()
  const { weekStart, weekEnd } = useWeekNavigator()

  const summary = trpc.biometrics.getVitalsSummary.useQuery({ side, startDate: weekStart, endDate: weekEnd }, { refetchInterval: 30000 })
  const occupancy = trpc.biometrics.getOccupancy.useQuery(undefined, { refetchInterval: 10000 })
  const fileCount = trpc.biometrics.getFileCount.useQuery({}, { refetchInterval: 30000 })
  const vitals = trpc.biometrics.getVitals.useQuery({ side, startDate: weekStart, endDate: weekEnd, limit: 200 }, { refetchInterval: 30000 })

  const rows = (vitals.data ?? []) as VitalRow[]
  const s = summary.data

  const columns: Array<Column<VitalRow>> = [
    { key: 'timestamp', header: 'Time', render: r => <span className="font-mono text-[11px] text-zinc-400">{new Date(r.timestamp).toLocaleString()}</span>, sortValue: r => new Date(r.timestamp).getTime() },
    { key: 'heartRate', header: 'HR', align: 'right', render: r => <span>{fmtNum(r.heartRate)}</span>, sortValue: r => r.heartRate ?? -1 },
    { key: 'hrv', header: 'HRV', align: 'right', render: r => <span>{fmtNum(r.hrv)}</span>, sortValue: r => r.hrv ?? -1 },
    { key: 'breathingRate', header: 'BR', align: 'right', render: r => <span>{fmtNum(r.breathingRate, 1)}</span>, sortValue: r => r.breathingRate ?? -1 },
    { key: 'side', header: 'Side', render: r => <span className="capitalize text-zinc-400">{r.side}</span>, sortValue: r => r.side },
  ]

  // Live "is data actually being written" check — the pitfall is a bed that
  // reads as occupied while the ingest pipeline has quietly stalled.
  const flow = biometricsFlowStatus(rows, occupancy.data, fileCount.data)

  return (
    <div className="space-y-3">
      <SectionHeader title="Biometrics" hint={`${sideLabel(side)} · this week`} />

      <DataFlowBanner tone={flow.tone} label={flow.label} />

      <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
        <Metric label="Avg HR" value={s ? fmtNum(s.avgHeartRate) : '—'} />
        <Metric label="HR min/max" value={s ? `${fmtNum(s.minHeartRate)}/${fmtNum(s.maxHeartRate)}` : '—'} />
        <Metric label="Avg HRV" value={s ? fmtNum(s.avgHRV) : '—'} />
        <Metric label="Avg BR" value={s ? fmtNum(s.avgBreathingRate, 1) : '—'} />
        <Metric label="Records" value={s ? String(s.recordCount) : '—'} />
        <Metric label="RAW files" value={fileCount.data ? `${fileCount.data.rawFiles.left}+${fileCount.data.rawFiles.right} · ${fileCount.data.totalSizeMB}MB` : '—'} />
      </div>

      <div className="rounded-xl bg-zinc-900/80 p-3">
        <h3 className="mb-1 text-xs font-medium text-white">{`Vitals trend · ${sideLabel(side)}`}</h3>
        <BiometricsTrendChart rows={rows} />
      </div>

      {occupancy.data && (
        <div className="grid grid-cols-2 gap-2">
          {(['left', 'right'] as const).map((sd) => {
            const o = occupancy.data[sd]
            return (
              <div key={sd} className="rounded-xl bg-zinc-900/80 p-3 text-xs">
                <p className="mb-1 font-medium capitalize text-white">{`${sd} side`}</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  <Stat label="Occupied" value={o.occupied ? 'yes' : 'no'} />
                  <Stat label="Available" value={o.available ? 'yes' : 'no'} />
                  <Stat label="Movement" value={o.movement.active ? `active (${fmtNum(o.movement.peakScore)})` : 'idle'} />
                  <Stat label="Level dev" value={fmtNum(o.level.deviation, 1)} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div>
        <h3 className="mb-1.5 text-xs font-medium text-white">{`Recent vitals (${rows.length})`}</h3>
        <DataTable columns={columns} rows={rows} getRowKey={(r, i) => `${new Date(r.timestamp).getTime()}-${i}`} empty={vitals.isLoading ? 'Loading…' : 'No vitals this week'} />
      </div>
    </div>
  )
}

function sideLabel(side: string): string {
  return side.charAt(0).toUpperCase() + side.slice(1)
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
    <div className="space-y-4">
      <SectionHeader title="System Health" hint="" />
      {/*
        Two columns with a deliberate information architecture:
          · Operational — live subsystem status, ordered by what you check
            first when debugging: brain (Core) → thermal link (Hardware) →
            connectivity (Network) → granular systemd units (Services).
          · Device — identity/capacity facts and the two control surfaces
            (internet access, updates), which are actions rather than health.
        Cards start expanded on desktop — there's room to show every check.
      */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <ColumnLabel>Operational</ColumnLabel>
          <HealthStatusCard title="Core" description="Server, database, scheduler" icon={Server} iconColor="text-sky-400" iconBg="bg-sky-400/20" services={coreServices} isLoading={system.isLoading} defaultExpanded />
          <HealthStatusCard title="Hardware" description="DAC socket and monitoring" icon={Cpu} iconColor="text-purple-400" iconBg="bg-purple-400/20" services={hardwareServices} isLoading={hardware.isLoading || dacMonitor.isLoading} defaultExpanded />
          <HealthStatusCard title="Network" description="WiFi and internet" icon={Radio} iconColor="text-teal-400" iconBg="bg-teal-400/20" services={networkServices} isLoading={wifi.isLoading} defaultExpanded />
          <HealthStatusCard title="Services" description="Systemd service units" icon={Cog} iconColor="text-cyan-400" iconBg="bg-cyan-400/20" services={systemdServices} isLoading={logSources.isLoading} defaultExpanded />
        </div>

        <div className="space-y-2">
          <ColumnLabel>Device &amp; maintenance</ColumnLabel>
          {/* Status-page detail duplicated in: build/disk, internet access, updates. */}
          <SystemInfoCard />
          <InternetToggleCard />
          <UpdateCard />
        </div>
      </div>
    </div>
  )
}

// ── Sensors (live data duplicated from the Sensors screen) ───────────────────

function SensorsPanel() {
  return (
    <div className="space-y-3">
      <SectionHeader title="Sensors" hint="live" />
      <div className="mx-auto max-w-xl xl:mx-0">
        <SensorsScreen />
      </div>
    </div>
  )
}

// ── Calibration (inline, no modal) ───────────────────────────────────────────

const CAL_SENSORS = ['piezo', 'capacitance', 'temperature'] as const
type CalSensor = (typeof CAL_SENSORS)[number]

function CalibrationPanel() {
  const { side } = useSide()
  const utils = trpc.useUtils()
  const [triggering, setTriggering] = useState<CalSensor | null>(null)

  const status = trpc.calibration.getStatus.useQuery({ side }, { refetchInterval: 5000 })
  const triggerSingle = trpc.calibration.triggerCalibration.useMutation({
    onSuccess: () => {
      utils.calibration.getStatus.invalidate({ side })
      setTriggering(null)
    },
    onError: () => setTriggering(null),
  })
  const triggerFull = trpc.calibration.triggerFullCalibration.useMutation({
    onSuccess: () => utils.calibration.getStatus.invalidate({ side }),
  })

  const data = status.data
  const anyActive = data && CAL_SENSORS.some(t => data[t]?.status === 'running' || data[t]?.status === 'pending')

  return (
    <div className="space-y-3">
      <SectionHeader title="Calibration" hint={sideLabel(side)} />

      {(triggerSingle.error || triggerFull.error) && (
        <div className="rounded-lg bg-red-900/20 px-3 py-2 text-[11px] text-red-400">
          {triggerSingle.error?.message || triggerFull.error?.message}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        {CAL_SENSORS.map((type) => {
          const p = data?.[type]
          const st = p?.status ?? 'unknown'
          const active = st === 'running' || st === 'pending'
          const q = p?.qualityScore
          return (
            <div key={type} className="space-y-2 rounded-xl bg-zinc-900/80 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium capitalize text-white">{type}</span>
                <CalStatusBadge status={st} />
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <Stat label="Quality" value={q != null ? `${Math.round(q * 100)}%` : '—'} />
                <Stat label="Samples" value={p?.samplesUsed != null ? String(p.samplesUsed) : '—'} />
                <Stat label="Calibrated" value={p?.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'} />
                <Stat label="Expires" value={p?.expiresAt ? new Date(p.expiresAt).toLocaleDateString() : '—'} />
              </div>
              {p?.errorMessage && <p className="text-[10px] text-red-400/80">{p.errorMessage}</p>}
              <button
                type="button"
                onClick={() => {
                  setTriggering(type)
                  triggerSingle.mutate({ side, sensorType: type })
                }}
                disabled={triggering === type || active}
                className="w-full rounded-lg bg-zinc-800 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:bg-zinc-700 disabled:text-zinc-600"
              >
                {triggering === type
                  ? <Loader2 size={12} className="mx-auto animate-spin" />
                  : active ? (st === 'running' ? 'Running…' : 'Pending') : 'Calibrate'}
              </button>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={() => triggerFull.mutate({})}
        disabled={triggerFull.isPending || !!anyActive}
        className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
      >
        {triggerFull.isPending ? <Loader2 size={13} className="animate-spin" /> : <SlidersHorizontal size={13} />}
        Calibrate all sensors
      </button>
    </div>
  )
}

function CalStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'bg-emerald-500/15 text-emerald-300',
    running: 'bg-amber-500/15 text-amber-300',
    pending: 'bg-zinc-600/20 text-zinc-300',
    failed: 'bg-red-500/15 text-red-300',
    unknown: 'bg-zinc-600/20 text-zinc-500',
  }
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${map[status] ?? map.unknown}`}>{status}</span>
}

// ── Logs ─────────────────────────────────────────────────────────────────────

function LogsPanel() {
  return (
    <div className="space-y-4">
      <RawLogDump />
      <div className="grid gap-3 xl:grid-cols-2">
        <SystemLogViewer />
        <section className="rounded-2xl border border-zinc-800/50 bg-zinc-900/80 p-3">
          <FirmwareLogConsole />
        </section>
      </div>
    </div>
  )
}

/** Copy-paste-friendly raw journalctl dump for a chosen unit. */
function RawLogDump() {
  const sources = trpc.system.getLogSources.useQuery({})
  const [unit, setUnit] = useState('sleepypod.service')
  const [copied, setCopied] = useState(false)
  const logs = trpc.system.getLogs.useQuery({ unit, lines: 200 }, { refetchInterval: 15000 })

  const text = useMemo(() => (logs.data?.lines ?? []).join('\n'), [logs.data])

  const copy = () => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/80 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium text-white">Raw logs</h3>
        <select
          value={unit}
          onChange={e => setUnit(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300"
        >
          {(sources.data?.sources ?? [{ unit: 'sleepypod.service', name: 'Core', active: true }]).map(s => (
            <option key={s.unit} value={s.unit}>{s.name}</option>
          ))}
        </select>
        <span className="text-[10px] text-zinc-500">{`${logs.data?.lines?.length ?? 0} lines · journalctl`}</span>
        <button
          type="button"
          onClick={copy}
          disabled={!text}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-40"
        >
          {copied ? <ClipboardCheck size={12} className="text-emerald-400" /> : <Clipboard size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <textarea
        readOnly
        value={logs.isLoading ? 'Loading…' : text || 'No log output'}
        className="h-72 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-300"
      />
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

function DataFlowBanner({ tone, label }: { tone: 'ok' | 'warn' | 'error' | 'idle', label: string }) {
  const styles = {
    ok: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20',
    warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/20',
    error: 'bg-red-500/15 text-red-300 ring-red-500/30',
    idle: 'bg-zinc-800/60 text-zinc-400 ring-zinc-700/40',
  }[tone]
  return (
    <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ring-1 ${styles}`}>
      <HeartPulse size={13} className="shrink-0" />
      <span>{label}</span>
    </div>
  )
}

function ColumnLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{children}</h2>
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

// ── Automations ─────────────────────────────────────────────────────────────
// Compact mirror of the Automations console's diagnostics, in the console's zinc
// aesthetic. The full builder lives at /automations; this surfaces live state and
// the audit trail alongside the pod's other diagnostics.

function automationsAgo(d: Date | string | null): string {
  if (!d) return 'never'
  const ms = Date.now() - new Date(d).getTime()
  if (ms < 60_000) return 'now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function AutomationsPanel() {
  const pathname = usePathname()
  const lang = pathname?.split('/')[1] ?? 'en'
  const status = trpc.automations.status.useQuery({}, { refetchInterval: 15000 })
  const runs = trpc.automations.runs.useQuery({ limit: 40 }, { refetchInterval: 15000 })
  const setKill = trpc.automations.setKillSwitch.useMutation({ onSuccess: () => status.refetch() })

  const globalEnabled = status.data?.globalEnabled ?? true
  const rules = status.data?.rules ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Automations</h2>
          <p className="text-xs text-zinc-500">Reactive WHEN/IF/THEN rules · live state &amp; run log</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setKill.mutate({ enabled: !globalEnabled })}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${globalEnabled ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/40 bg-red-500/10 text-red-300'}`}
          >
            <span className={`h-2 w-2 rounded-full ${globalEnabled ? 'bg-emerald-400' : 'bg-red-400'}`} />
            {globalEnabled ? 'Running' : 'Halted'}
          </button>
          <Link href={`/${lang}/automations`} className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700/60">
            Open builder →
          </Link>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {rules.length === 0 && (
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4 text-xs text-zinc-500">
            No automations yet. Build one in the Automations console.
          </div>
        )}
        {rules.map(r => (
          <div key={r.id} className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-zinc-100">{r.name}</span>
              <Tag className={!r.enabled ? 'bg-zinc-800 text-zinc-400' : r.dryRun ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}>
                {!r.enabled ? 'paused' : r.dryRun ? 'dry-run' : 'active'}
              </Tag>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-zinc-400">
              <div>
                <span className="text-zinc-600">side</span>
                {' '}
                {r.side ?? 'L+R'}
              </div>
              <div>
                <span className="text-zinc-600">today</span>
                {' '}
                {r.firesToday}
              </div>
              <div>
                <span className="text-zinc-600">last</span>
                {' '}
                {automationsAgo(r.lastFiredAt)}
              </div>
              <div>
                <span className="text-zinc-600">cooldown</span>
                {' '}
                {r.cooldownMin ? `${r.cooldownMin}m` : '—'}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/40">
        <div className="border-b border-zinc-800/60 px-4 py-2.5 text-xs font-medium text-zinc-300">Run log · audit trail</div>
        <div className="max-h-[360px] overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-zinc-950/90 text-[10px] uppercase tracking-wide text-zinc-600">
              <tr>
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-2 py-2 font-medium">Rule</th>
                <th className="px-2 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data ?? []).length === 0 && (
                <tr><td colSpan={3} className="px-4 py-6 text-center text-zinc-600">No evaluations recorded yet.</td></tr>
              )}
              {(runs.data ?? []).map((r) => {
                const d = new Date(r.firedAt)
                const tone = r.outcome === 'fired' || r.outcome === 'clamped' ? 'text-red-300' : r.outcome === 'dry_run' ? 'text-amber-300' : 'text-zinc-400'
                return (
                  <tr key={r.id} className="border-t border-zinc-800/40">
                    <td className="px-4 py-2 font-mono text-zinc-400 whitespace-nowrap">{`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}</td>
                    <td className="px-2 py-2 text-zinc-200">{r.ruleName ?? `#${r.automationId}`}</td>
                    <td className={`px-2 py-2 ${tone}`}>{r.outcome.replace('_', '-')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
