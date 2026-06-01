'use client'

import { trpc } from '@/src/utils/trpc'

const VERDICT_STYLES: Record<string, { label: string, className: string }> = {
  delivering: { label: 'DELIVERING', className: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  idle: { label: 'IDLE (at target)', className: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  off: { label: 'OFF', className: 'bg-zinc-600/20 text-zinc-400 ring-zinc-600/30' },
  stalled: { label: 'STALLED — NO FLOW', className: 'bg-red-500/20 text-red-300 ring-red-500/40' },
}

function fmtF(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(1)}°F`
}

function fmtAge(sec: number | null): string {
  if (sec == null) return 'no reading'
  if (sec < 90) return `${sec}s ago`
  return `${Math.round(sec / 60)}m ago`
}

export default function DebugPage() {
  // Poll fast enough to catch a pump dropping out, slow enough to be cheap.
  const thermal = trpc.health.thermal.useQuery({}, { refetchInterval: 5000 })
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: 30000 })

  const data = thermal.data

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-2 sm:p-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-white">Thermal debug</h1>
        <span className="text-xs text-zinc-500">
          {thermal.isFetching ? 'refreshing…' : 'live · 5s'}
        </span>
      </div>

      {thermal.isLoading && <p className="text-sm text-zinc-400">Loading…</p>}
      {thermal.error && <p className="text-sm text-red-400">{thermal.error.message}</p>}

      {data && (
        <>
          <div className="grid grid-cols-3 gap-3 rounded-2xl bg-zinc-900/80 p-3 text-sm sm:p-4">
            <Stat label="Pump-stall protection" value={data.pumpStallProtectionEnabled ? 'ENABLED' : 'disabled'} />
            <Stat label="Heatsink" value={fmtF(data.heatsinkTempF)} />
            <Stat label="Ambient" value={fmtF(data.ambientTempF)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {data.sides.map((s) => {
              const v = VERDICT_STYLES[s.verdict]
              const diverged = s.verdict === 'stalled'
              return (
                <div
                  key={s.side}
                  className={`space-y-3 rounded-2xl bg-zinc-900/80 p-4 ring-1 ${diverged ? 'ring-red-500/40' : 'ring-transparent'}`}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium capitalize text-white">
                      {s.side}
                      {' '}
                      side
                    </h2>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${v.className}`}>
                      {v.label}
                    </span>
                  </div>

                  {s.note && <p className="text-xs text-red-300">{s.note}</p>}

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <Stat label="Commanded target" value={s.isPowered ? fmtF(s.targetTempF) : 'off'} />
                    <Stat label="Current bed" value={fmtF(s.currentTempF)} />
                    <Stat label="Pump" value={s.pumpRpm == null ? '—' : `${s.pumpRpm} rpm`} />
                    <Stat label="Flow reading" value={fmtAge(s.readingAgeSec)} />
                    <Stat label="Water temp" value={fmtF(s.waterTempF)} />
                    <Stat label="Bed surface" value={fmtF(s.bedSurfaceTempF)} />
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
                    {s.guardBlocked && <Tag className="bg-red-500/20 text-red-300">guard blocked</Tag>}
                    {s.isAlarmVibrating && <Tag className="bg-amber-500/20 text-amber-300">alarm vibrating</Tag>}
                    {s.poweredOnAt && (
                      <span>{`on since ${new Date(s.poweredOnAt).toLocaleTimeString()}`}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
            <h2 className="mb-2 text-sm font-medium text-white">Next scheduled jobs</h2>
            {scheduler.data
              ? (
                  <ul className="space-y-1 text-xs text-zinc-400">
                    {scheduler.data.upcomingJobs.slice(0, 8).map(j => (
                      <li key={j.id} className="flex justify-between gap-2">
                        <span className="truncate">
                          {j.type}
                          {j.side ? ` · ${j.side}` : ''}
                          {' '}
                          <span className="text-zinc-600">{j.id}</span>
                        </span>
                        <span className="shrink-0 text-zinc-500">
                          {j.nextRun ? new Date(j.nextRun).toLocaleString() : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              : <p className="text-xs text-zinc-500">Loading…</p>}
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string, value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-zinc-100">{value}</p>
    </div>
  )
}

function Tag({ children, className }: { children: React.ReactNode, className: string }) {
  return <span className={`rounded px-1.5 py-0.5 ${className}`}>{children}</span>
}
