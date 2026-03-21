'use client'

import { trpc } from '@/src/utils/trpc'
import { HardDrive, GitBranch, GitCommit, Calendar } from 'lucide-react'

/**
 * SystemInfoCard — displays firmware/build version info and disk usage.
 *
 * Wires into:
 * - system.getVersion → branch, commitHash, commitTitle, buildDate
 * - system.getDiskUsage → totalBytes, usedBytes, availableBytes, usedPercent
 */
export function SystemInfoCard() {
  const version = trpc.system.getVersion.useQuery({})
  const disk = trpc.system.getDiskUsage.useQuery({})

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    const val = bytes / Math.pow(1024, i)
    return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`
  }

  const isLoading = version.isLoading || disk.isLoading
  const versionData = version.data
  const diskData = disk.data

  // Disk usage bar color based on usage percentage
  const diskBarColor
    = (diskData?.usedPercent ?? 0) >= 90
      ? 'bg-red-500'
      : (diskData?.usedPercent ?? 0) >= 75
          ? 'bg-amber-500'
          : 'bg-sky-500'

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2 sm:mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20">
          <HardDrive size={14} className="text-sky-400" />
        </div>
        <h3 className="text-sm font-medium text-white">System Info</h3>
      </div>

      {isLoading
        ? (
            <div className="flex items-center gap-2 py-4">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
              <span className="text-xs text-zinc-500">Loading system info...</span>
            </div>
          )
        : (
            <div className="space-y-3">
              {/* Version info rows */}
              {versionData && (
                <div className="space-y-2">
                  <InfoRow
                    icon={<GitBranch size={12} />}
                    label="Branch"
                    value={versionData.branch}
                  />
                  <InfoRow
                    icon={<GitCommit size={12} />}
                    label="Commit"
                    value={versionData.commitHash !== 'unknown' ? versionData.commitHash.slice(0, 7) : 'unknown'}
                    subValue={versionData.commitTitle !== 'unknown' ? versionData.commitTitle : undefined}
                  />
                  <InfoRow
                    icon={<Calendar size={12} />}
                    label="Build Date"
                    value={versionData.buildDate !== 'unknown' ? formatBuildDate(versionData.buildDate) : 'unknown'}
                  />
                </div>
              )}

              {/* Disk usage */}
              {diskData && diskData.totalBytes > 0 && (
                <div className="border-t border-zinc-800 pt-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs text-zinc-500">Disk Usage</span>
                    <span className="text-xs tabular-nums text-zinc-400">
                      {formatBytes(diskData.usedBytes)}
                      {' / '}
                      {formatBytes(diskData.totalBytes)}
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full rounded-full transition-all ${diskBarColor}`}
                      style={{ width: `${Math.min(diskData.usedPercent, 100)}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span className="text-[10px] text-zinc-600">
                      {diskData.usedPercent?.toFixed(1) ?? '0'}
                      % used
                    </span>
                    <span className="text-[10px] text-zinc-600">
                      {formatBytes(diskData.availableBytes)}
                      {' free'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
    </div>
  )
}

function InfoRow({
  icon,
  label,
  value,
  subValue,
}: {
  icon: React.ReactNode
  label: string
  value: string
  subValue?: string
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-zinc-500">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-zinc-500">{label}</span>
          <span className="truncate text-xs font-medium tabular-nums text-zinc-300">
            {value}
          </span>
        </div>
        {subValue && (
          <p className="mt-0.5 truncate text-[10px] text-zinc-600">{subValue}</p>
        )}
      </div>
    </div>
  )
}

function formatBuildDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  catch {
    return dateStr
  }
}
