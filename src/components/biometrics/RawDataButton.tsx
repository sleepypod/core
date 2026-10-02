'use client'

import { useState, useCallback, useMemo } from 'react'
import { Download, FileText, HardDrive, Trash2, Database, Package } from 'lucide-react'
import { Button, Card, GhostIcon, InlineError, Modal } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'
import { useBiometricsSide } from '@/src/hooks/useBiometricsSide'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'

function formatCSVDate(date: Date): string {
  return new Date(date).toISOString()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateVitalsCSV(vitals: any[]): string {
  const header = 'timestamp,heart_rate,hrv,breathing_rate,side'
  const rows = vitals.map(v =>
    `${formatCSVDate(v.timestamp)},${v.heartRate ?? ''},${v.hrv ?? ''},${v.breathingRate ?? ''},${v.side}`
  )
  return [header, ...rows].join('\n')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateSleepCSV(records: any[]): string {
  const header = 'entered_bed_at,left_bed_at,duration_seconds,times_exited_bed,side'
  const rows = records.map(r =>
    `${formatCSVDate(r.enteredBedAt)},${formatCSVDate(r.leftBedAt)},${r.sleepDurationSeconds},${r.timesExitedBed},${r.side}`
  )
  return [header, ...rows].join('\n')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateMovementCSV(movement: any[]): string {
  const header = 'timestamp,total_movement,side'
  const rows = movement.map(m =>
    `${formatCSVDate(m.timestamp)},${m.totalMovement},${m.side}`
  )
  return [header, ...rows].join('\n')
}

function downloadCSV(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  // The anchor must be in the document and the object URL must outlive the
  // click: iOS Safari starts the download asynchronously, so revoking the URL
  // synchronously (or clicking a detached node) aborts it and leaves a blank
  // blob page instead of saving the file.
  document.body.appendChild(link)
  link.click()
  setTimeout(() => {
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, 1000)
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Raw data export button + bottom sheet matching iOS RawDataSheet.
 * Self-contained: fetches data from tRPC for the current week/side.
 * Allows CSV export of vitals, sleep, and movement data.
 * Also wires into the raw tRPC router for RAW file management (list, download, delete)
 * and disk usage monitoring.
 */
export function RawDataButton({ variant = 'card', range }: {
  /** `button` renders just the trigger, for a footer. */
  variant?: 'card' | 'button'
  /** Export window; defaults to the shared week navigator's week. */
  range?: { start: Date, end: Date }
} = {}) {
  const [isOpen, setIsOpen] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const { side } = useBiometricsSide()
  const week = useWeekNavigator()
  const weekStart = range?.start ?? week.weekStart
  const weekEnd = range?.end ?? week.weekEnd
  const utils = trpc.useUtils()

  // Only fetch when sheet is open to avoid unnecessary queries
  const vitalsQuery = trpc.biometrics.getVitals.useQuery(
    { side, startDate: weekStart, endDate: weekEnd, limit: 10000 },
    { enabled: isOpen }
  )
  const sleepQuery = trpc.biometrics.getSleepRecords.useQuery(
    { side, startDate: weekStart, endDate: weekEnd, limit: 30 },
    { enabled: isOpen }
  )
  const movementQuery = trpc.biometrics.getMovement.useQuery(
    { side, startDate: weekStart, endDate: weekEnd, limit: 1000 },
    { enabled: isOpen }
  )

  // Raw file management — wired to raw tRPC router
  const fileCountQuery = trpc.biometrics.getFileCount.useQuery(
    {},
    { enabled: isOpen }
  )
  const diskUsageQuery = trpc.raw.diskUsage.useQuery(
    {},
    { enabled: isOpen }
  )
  const rawFilesQuery = trpc.raw.files.useQuery(
    {},
    { enabled: isOpen && showFiles }
  )

  const deleteFileMutation = trpc.raw.deleteFile.useMutation({
    onSuccess: () => {
      // Invalidate both file queries after deletion
      utils.raw.files.invalidate()
      utils.raw.diskUsage.invalidate()
      utils.biometrics.getFileCount.invalidate()
      setDeletingFile(null)
    },
    onError: () => {
      setDeletingFile(null)
    },
  })

  const vitals = useMemo(() => vitalsQuery.data ?? [], [vitalsQuery.data])
  const sleepRecords = useMemo(() => sleepQuery.data ?? [], [sleepQuery.data])
  const movement = useMemo(() => movementQuery.data ?? [], [movementQuery.data])
  const fileCount = fileCountQuery.data
  const diskUsage = diskUsageQuery.data

  const rawFiles = (rawFilesQuery.data ?? []) as Array<{ name: string, sizeBytes: number, modifiedAt: string }>

  const exportVitals = useCallback(() => {
    downloadCSV(generateVitalsCSV(vitals), `vitals-${side}.csv`)
  }, [vitals, side])

  const exportSleep = useCallback(() => {
    downloadCSV(generateSleepCSV(sleepRecords), `sleep-${side}.csv`)
  }, [sleepRecords, side])

  const exportMovement = useCallback(() => {
    downloadCSV(generateMovementCSV(movement), `movement-${side}.csv`)
  }, [movement, side])

  const exportAll = useCallback(() => {
    const dateStr = new Date().toISOString().slice(0, 10)
    const combined = [
      '# Sleepypod Raw Data Export',
      `# Side: ${side}`,
      `# Date: ${new Date().toISOString()}`,
      '',
      '## Vitals',
      generateVitalsCSV(vitals),
      '',
      '## Sleep',
      generateSleepCSV(sleepRecords),
      '',
      '## Movement',
      generateMovementCSV(movement),
    ].join('\n')
    downloadCSV(combined, `sleepypod-${side}-${dateStr}.csv`)
  }, [side, vitals, sleepRecords, movement])

  const handleDeleteFile = useCallback((filename: string) => {
    setDeletingFile(filename)
    deleteFileMutation.mutate({ filename })
  }, [deleteFileMutation])

  const handleDownloadRawFile = useCallback((filename: string) => {
    // Use the Next.js API route for secure raw file download
    const link = document.createElement('a')
    link.href = `/api/raw/${encodeURIComponent(filename)}`
    link.download = filename
    link.click()
  }, [])

  const exportArchive = useCallback(() => {
    const startTs = Math.floor(weekStart.getTime() / 1000)
    const endTs = Math.floor(weekEnd.getTime() / 1000)
    const link = document.createElement('a')
    link.href = `/api/export/archive?startTs=${startTs}&endTs=${endTs}&include=raw,db`
    link.click()
  }, [weekStart, weekEnd])

  const close = () => {
    setIsOpen(false)
    setShowFiles(false)
  }

  const csvFiles = [
    { name: `vitals-${side}.csv`, rows: vitals.length, onClick: exportVitals },
    { name: `sleep-${side}.csv`, rows: sleepRecords.length, onClick: exportSleep },
    { name: `movement-${side}.csv`, rows: movement.length, onClick: exportMovement },
  ]

  return (
    <>
      {variant === 'button'
        ? <Button icon={Download} size="sm" onClick={() => setIsOpen(true)}>Raw data</Button>
        : (
            <Card flat className="flex-row items-center gap-3">
              <Database size={16} className="shrink-0 text-icon" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm">Raw data</span>
                <span className="text-xs text-fg-2">CSV export and sensor files for the selected week</span>
              </div>
              <Button icon={Download} size="sm" onClick={() => setIsOpen(true)}>Export raw data</Button>
            </Card>
          )}

      <Modal open={isOpen} onClose={close} title="Raw data" icon={Database} iconClassName="text-icon">
        <div className="flex flex-col gap-1.5 rounded-ctl border border-line px-3 py-2.5 text-[13px]">
          <StatRow label="Side" value={side} capitalize />
          <StatRow label="Vitals records" value={String(vitals.length)} />
          <StatRow label="Sleep sessions" value={String(sleepRecords.length)} />
          <StatRow label="Movement records" value={String(movement.length)} />
          {(fileCount || diskUsage) && (
            <>
              <div className="my-1 border-t border-line" />
              {fileCount && (
                <>
                  <StatRow label="Raw files (left)" value={String(fileCount.rawFiles.left)} />
                  <StatRow label="Raw files (right)" value={String(fileCount.rawFiles.right)} />
                  <StatRow label="Total size" value={`${fileCount.totalSizeMB} MB`} />
                </>
              )}
              {diskUsage && diskUsage.availableBytes > 0 && (
                <StatRow label="Disk available" value={formatBytes(diskUsage.availableBytes)} />
              )}
            </>
          )}
        </div>

        <div className="flex flex-col">
          {csvFiles.map(f => (
            <button
              key={f.name}
              type="button"
              onClick={f.onClick}
              disabled={f.rows === 0}
              className="flex min-h-11 cursor-pointer items-center gap-3 border-0 border-t border-line bg-transparent px-0.5 py-2.5 text-left first:border-t-0 hover:bg-active disabled:cursor-default disabled:opacity-45"
            >
              <FileText size={14} className="shrink-0 text-icon" />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px]">{f.name}</div>
                <div className="font-mono text-[11px] text-fg-2">{`${f.rows} rows`}</div>
              </div>
              <Download size={15} className="shrink-0 text-fg-2" />
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            icon={Download}
            full
            onClick={exportAll}
            disabled={vitals.length === 0 && sleepRecords.length === 0 && movement.length === 0}
          >
            Export all as CSV
          </Button>
          <p className="text-center text-xs text-fg-2">CSV files open in Excel or Numbers, or import into Python/R.</p>
          <Button icon={Package} full onClick={exportArchive}>Export archive (.tar.gz)</Button>
          <p className="text-center text-xs text-fg-2">
            RAW waveforms + biometrics.db copy for this week. Untar and open biometrics.db with any SQLite client.
          </p>
        </div>

        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={() => setShowFiles(!showFiles)}
            aria-expanded={showFiles}
            className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-ctl border-0 bg-transparent px-0.5 text-left hover:bg-active"
          >
            <HardDrive size={14} className="text-icon" />
            <span className="flex-1 text-sm">Sensor data files</span>
            <span className="font-mono text-xs text-fg-2">{diskUsage ? `${diskUsage.rawFileCount} files` : '…'}</span>
          </button>

          {showFiles && (
            <div className="flex flex-col">
              {rawFilesQuery.isLoading && <p className="py-4 text-center text-xs text-fg-2">Loading files…</p>}
              {rawFilesQuery.isError && <InlineError className="py-2 text-center">Failed to load files</InlineError>}
              {rawFiles.length === 0 && !rawFilesQuery.isLoading && !rawFilesQuery.isError && (
                <p className="py-4 text-center text-xs text-fg-2">No RAW files found</p>
              )}

              {rawFiles.map((file, idx) => (
                <div key={file.name} className="flex items-center gap-2 border-t border-line py-2 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{file.name}</div>
                    <div className="font-mono text-[11px] text-fg-2">
                      {`${formatBytes(file.sizeBytes)} · ${formatDate(file.modifiedAt)}`}
                    </div>
                  </div>
                  <GhostIcon icon={Download} size={14} label={`Download ${file.name}`} onClick={() => handleDownloadRawFile(file.name)} />
                  {/* Disabled for the active (newest, idx===0) file */}
                  <GhostIcon
                    icon={Trash2}
                    size={14}
                    label={idx === 0 ? 'Cannot delete active file' : `Delete ${file.name}`}
                    onClick={() => handleDeleteFile(file.name)}
                    disabled={idx === 0 || deletingFile === file.name}
                    className="hover:text-danger"
                  />
                </div>
              ))}

              {deleteFileMutation.isError && (
                <InlineError className="text-center">{deleteFileMutation.error?.message ?? 'Delete failed'}</InlineError>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}

function StatRow({
  label,
  value,
  capitalize,
}: {
  label: string
  value: string
  capitalize?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-2">{label}</span>
      <span className={cn('font-mono', capitalize && 'capitalize')}>{value}</span>
    </div>
  )
}
