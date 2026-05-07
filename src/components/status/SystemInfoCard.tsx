'use client'

import { trpc } from '@/src/utils/trpc'
import { HardDrive, GitBranch, GitCommit, Calendar } from 'lucide-react'

/**
 * SystemInfoCard — firmware/build version + per-mount storage breakdown.
 *
 * Storage sections (Pod 5 layout — Pod 4 falls back gracefully when a mount
 * is absent):
 *   - eMMC                  → /persistent
 *   - Biometrics tmpfs      → /persistent/biometrics (live RAW workspace)
 *   - Biometrics archive    → /persistent/biometrics-archive (gzipped)
 *
 * DB size is intentionally omitted — it lives on eMMC and is rolled into that
 * section's total.
 */
export function SystemInfoCard() {
  const version = trpc.system.getVersion.useQuery({})
  const storage = trpc.system.getStorageBreakdown.useQuery({}, { refetchInterval: 30_000 })

  const isLoading = version.isLoading || storage.isLoading
  const versionData = version.data
  const storageData = storage.data

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
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

              {storageData && (
                <div className="space-y-3 border-t border-zinc-800 pt-3">
                  {storageData.emmc.totalBytes > 0 && (
                    <DiskSection
                      label="eMMC"
                      sublabel="/persistent"
                      totalBytes={storageData.emmc.totalBytes}
                      usedBytes={storageData.emmc.usedBytes}
                      availableBytes={storageData.emmc.availableBytes}
                      usedPercent={storageData.emmc.usedPercent}
                    />
                  )}
                  {storageData.biometricsTmpfs.totalBytes > 0 && (
                    <DiskSection
                      label="Biometrics tmpfs"
                      sublabel="/persistent/biometrics"
                      totalBytes={storageData.biometricsTmpfs.totalBytes}
                      usedBytes={storageData.biometricsTmpfs.usedBytes}
                      availableBytes={storageData.biometricsTmpfs.availableBytes}
                      usedPercent={storageData.biometricsTmpfs.usedPercent}
                    />
                  )}
                  {storageData.biometricsArchive.usedBytes > 0 && (
                    <ArchiveSection
                      usedBytes={storageData.biometricsArchive.usedBytes}
                      fileCount={storageData.biometricsArchive.fileCount}
                    />
                  )}
                </div>
              )}
            </div>
          )}
    </div>
  )
}

function DiskSection({
  label,
  sublabel,
  totalBytes,
  usedBytes,
  availableBytes,
  usedPercent,
}: {
  label: string
  sublabel: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usedPercent: number
}) {
  const barColor
    = usedPercent >= 90
      ? 'bg-red-500'
      : usedPercent >= 75
        ? 'bg-amber-500'
        : 'bg-sky-500'

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-zinc-400">{label}</span>
          <span className="font-mono text-[10px] text-zinc-600">{sublabel}</span>
        </div>
        <span className="text-xs tabular-nums text-zinc-400">
          {formatBytes(usedBytes)}
          {' / '}
          {formatBytes(totalBytes)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(usedPercent, 100)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between">
        <span className="text-[10px] text-zinc-600">
          {usedPercent.toFixed(1)}
          % used
        </span>
        <span className="text-[10px] text-zinc-600">
          {formatBytes(availableBytes)}
          {' free'}
        </span>
      </div>
    </div>
  )
}

function ArchiveSection({ usedBytes, fileCount }: { usedBytes: number, fileCount: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-zinc-400">Biometrics archive</span>
          <span className="font-mono text-[10px] text-zinc-600">/persistent/biometrics-archive</span>
        </div>
        <span className="text-xs tabular-nums text-zinc-400">
          {formatBytes(usedBytes)}
        </span>
      </div>
      <p className="mt-0.5 text-[10px] text-zinc-600">
        {fileCount}
        {' '}
        gzipped session
        {fileCount === 1 ? '' : 's'}
      </p>
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`
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
