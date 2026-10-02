'use client'

import { trpc } from '@/src/utils/trpc'
import { Card, CardHeader, InlineError, SettingRow, Skeleton } from '@/src/components/ds'
import { cn } from '@/lib/utils'

/**
 * SystemInfoCard — disk usage with a per-mount breakdown.
 *
 * Storage sections (Pod 5 layout — Pod 4 falls back gracefully when a mount
 * is absent):
 *   - eMMC                  → /persistent (bar: archive vs. everything else)
 *   - Biometrics archive    → /persistent/biometrics-archive (gzipped)
 *   - Biometrics tmpfs      → /persistent/biometrics (live RAW workspace, RAM)
 *
 * DB size is intentionally omitted — it lives on eMMC and is rolled into that
 * section's total.
 */
export function SystemInfoCard() {
  const storage = trpc.system.getStorageBreakdown.useQuery({}, { refetchInterval: 30_000 })
  const data = storage.data

  if (storage.isLoading) return <Skeleton className="h-[200px]" />

  const emmc = data?.emmc
  const archive = data?.biometricsArchive
  const tmpfs = data?.biometricsTmpfs
  const hasEmmc = !!emmc && emmc.totalBytes > 0
  const archiveBytes = archive?.usedBytes ?? 0
  const otherBytes = hasEmmc ? Math.max(0, emmc.usedBytes - archiveBytes) : 0
  const pct = (bytes: number) => (hasEmmc ? Math.min(100, (bytes / emmc.totalBytes) * 100) : 0)
  const usedTone = !hasEmmc ? '' : emmc.usedPercent >= 90 ? 'text-danger' : emmc.usedPercent >= 75 ? 'text-warn' : 'text-fg-2'

  return (
    <Card>
      <CardHeader
        title="Disk"
        right={hasEmmc && (
          <span className={cn('font-mono text-xs', usedTone)}>
            {`${Math.round(emmc.usedPercent)}% of ${formatBytes(emmc.totalBytes)}`}
          </span>
        )}
      />
      {storage.error && <InlineError>{storage.error.message}</InlineError>}
      {!storage.error && !hasEmmc && !(archive && archive.usedBytes > 0) && !(tmpfs && tmpfs.totalBytes > 0) && (
        <p className="text-[13px] text-fg-2">Storage details aren’t available on this device.</p>
      )}
      {hasEmmc && (
        <div
          className="flex h-2 gap-0.5 overflow-hidden rounded bg-line"
          role="img"
          aria-label={`${emmc.usedPercent.toFixed(1)}% of eMMC used`}
        >
          {archiveBytes > 0 && <span className="bg-cool" style={{ width: `${pct(archiveBytes)}%` }} />}
          <span className="bg-fg-2" style={{ width: `${pct(otherBytes)}%` }} />
        </div>
      )}
      {archive && archive.usedBytes > 0 && (
        <SettingRow
          label={<Legend className="bg-cool">Biometrics archive</Legend>}
          sub={`${archive.fileCount} gzipped session${archive.fileCount === 1 ? '' : 's'}`}
        >
          <Value>{formatBytes(archive.usedBytes)}</Value>
        </SettingRow>
      )}
      {hasEmmc && (
        <>
          <SettingRow label={<Legend className="bg-fg-2">System &amp; data</Legend>} sub="/persistent">
            <Value>{formatBytes(otherBytes)}</Value>
          </SettingRow>
          <SettingRow label={<Legend className="bg-line">Free</Legend>}>
            <Value>{formatBytes(emmc.availableBytes)}</Value>
          </SettingRow>
        </>
      )}
      {tmpfs && tmpfs.totalBytes > 0 && (
        <SettingRow label="RAW workspace" sub="/persistent/biometrics · tmpfs">
          <Value>{`${formatBytes(tmpfs.usedBytes)} / ${formatBytes(tmpfs.totalBytes)}`}</Value>
        </SettingRow>
      )}
    </Card>
  )
}

function Legend({ className, children }: { className: string, children: React.ReactNode }) {
  return (
    <>
      <span className={cn('size-2 shrink-0 rounded-[2px]', className)} />
      {children}
    </>
  )
}

function Value({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs text-fg-2">{children}</span>
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}
