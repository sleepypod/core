'use client'

import { useState, useCallback } from 'react'
import { Download, X, FileText, HardDrive, Trash2, Database } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
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
  link.click()
  URL.revokeObjectURL(url)
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
export function RawDataButton() {
  const [isOpen, setIsOpen] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const { side } = useSide()
  const { weekStart, weekEnd } = useWeekNavigator()
  const utils = trpc.useUtils()

  // Only fetch when sheet is open to avoid unnecessary queries
  const vitalsQuery = trpc.biometrics.getVitals.useQuery(
    { side, startDate: weekStart, endDate: weekEnd, limit: 1000 },
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

  const vitals = vitalsQuery.data ?? []
  const sleepRecords = sleepQuery.data ?? []
  const movement = movementQuery.data ?? []
  const fileCount = fileCountQuery.data
  const diskUsage = diskUsageQuery.data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawFiles = (rawFilesQuery.data ?? []) as Array<{ name: string; sizeBytes: number; modifiedAt: string }>

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

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-2xl bg-zinc-900/80 p-3 text-sm text-zinc-400 active:bg-zinc-800"
      >
        <Download size={16} />
        Export Raw Data
      </button>

      {/* Bottom sheet overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsOpen(false)
          }}
        >
          <div className="w-full max-w-md max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-zinc-900 p-4 pb-6 sm:p-5 sm:pb-8">
            {/* Sheet header */}
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Raw Data</h3>
              <button
                onClick={() => { setIsOpen(false); setShowFiles(false) }}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800"
              >
                <X size={16} className="text-zinc-400" />
              </button>
            </div>

            {/* Stats card — matches iOS statRow layout */}
            <div className="mb-4 rounded-xl bg-zinc-800/60 p-3 text-xs">
              <StatRow label="Side" value={side} capitalize />
              <StatRow label="Vitals records" value={String(vitals.length)} />
              <StatRow label="Sleep sessions" value={String(sleepRecords.length)} />
              <StatRow label="Movement records" value={String(movement.length)} />

              {/* Disk usage from raw tRPC router + biometrics.getFileCount */}
              {(fileCount || diskUsage) && (
                <>
                  <div className="my-2 border-t border-zinc-700" />
                  {fileCount && (
                    <>
                      <StatRow label="Raw files (left)" value={String(fileCount.rawFiles.left)} />
                      <StatRow label="Raw files (right)" value={String(fileCount.rawFiles.right)} />
                      <StatRow label="Total size" value={`${fileCount.totalSizeMB} MB`} />
                    </>
                  )}
                  {diskUsage && diskUsage.availableBytes > 0 && (
                    <StatRow
                      label="Disk available"
                      value={formatBytes(diskUsage.availableBytes)}
                    />
                  )}
                </>
              )}
            </div>

            {/* CSV Export Files — matches iOS fileRow layout */}
            <div className="mb-3 rounded-xl bg-zinc-800/60 overflow-hidden">
              <button
                onClick={exportVitals}
                disabled={vitals.length === 0}
                className="flex w-full min-h-[44px] items-center gap-3 p-3 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-40"
              >
                <FileText size={14} className="text-red-400 shrink-0" />
                <div className="flex-1 text-left">
                  <div className="font-mono text-xs">vitals-{side}.csv</div>
                  <div className="text-[10px] text-zinc-500">{vitals.length} rows</div>
                </div>
                <Download size={16} className="text-sky-400 shrink-0" />
              </button>

              <div className="border-t border-zinc-700/50" />

              <button
                onClick={exportSleep}
                disabled={sleepRecords.length === 0}
                className="flex w-full min-h-[44px] items-center gap-3 p-3 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-40"
              >
                <FileText size={14} className="text-sky-400 shrink-0" />
                <div className="flex-1 text-left">
                  <div className="font-mono text-xs">sleep-{side}.csv</div>
                  <div className="text-[10px] text-zinc-500">{sleepRecords.length} rows</div>
                </div>
                <Download size={16} className="text-sky-400 shrink-0" />
              </button>

              <div className="border-t border-zinc-700/50" />

              <button
                onClick={exportMovement}
                disabled={movement.length === 0}
                className="flex w-full min-h-[44px] items-center gap-3 p-3 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-40"
              >
                <FileText size={14} className="text-amber-400 shrink-0" />
                <div className="flex-1 text-left">
                  <div className="font-mono text-xs">movement-{side}.csv</div>
                  <div className="text-[10px] text-zinc-500">{movement.length} rows</div>
                </div>
                <Download size={16} className="text-sky-400 shrink-0" />
              </button>
            </div>

            {/* Export All button */}
            <button
              onClick={exportAll}
              disabled={vitals.length === 0 && sleepRecords.length === 0 && movement.length === 0}
              className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl bg-sky-600 p-3 text-sm font-medium text-white active:bg-sky-700 disabled:opacity-40"
            >
              <Download size={16} />
              Export All as CSV
            </button>

            {/* Info text — matches iOS */}
            <p className="mt-3 text-center text-[10px] text-zinc-500">
              CSV files can be opened in Excel, Numbers, or imported into Python/R for analysis.
            </p>

            {/* Raw sensor files section — wired to raw.files tRPC router */}
            <div className="mt-5 border-t border-zinc-700/50 pt-4">
              <button
                onClick={() => setShowFiles(!showFiles)}
                className="flex w-full min-h-[44px] items-center justify-between rounded-xl bg-zinc-800/60 p-3"
              >
                <div className="flex items-center gap-2">
                  <HardDrive size={14} className="text-zinc-400" />
                  <span className="text-xs font-medium text-zinc-300">
                    Sensor Data Files
                  </span>
                </div>
                <span className="text-[10px] text-zinc-500">
                  {diskUsage ? `${diskUsage.rawFileCount} files` : '…'}
                </span>
              </button>

              {showFiles && (
                <div className="mt-2 space-y-1">
                  {rawFilesQuery.isLoading && (
                    <div className="py-4 text-center text-xs text-zinc-500">Loading files…</div>
                  )}

                  {rawFilesQuery.isError && (
                    <div className="py-4 text-center text-xs text-red-400">
                      Failed to load files
                    </div>
                  )}

                  {rawFiles.length === 0 && !rawFilesQuery.isLoading && !rawFilesQuery.isError && (
                    <div className="py-4 text-center text-xs text-zinc-500">No RAW files found</div>
                  )}

                  {rawFiles.map((file, idx) => (
                    <div
                      key={file.name}
                      className="flex items-center gap-2 rounded-lg bg-zinc-800/40 p-2.5"
                    >
                      <Database size={12} className="text-zinc-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-mono text-[11px] text-zinc-300">
                          {file.name}
                        </div>
                        <div className="flex gap-2 text-[10px] text-zinc-500">
                          <span>{formatBytes(file.sizeBytes)}</span>
                          <span>·</span>
                          <span>{formatDate(file.modifiedAt)}</span>
                        </div>
                      </div>

                      {/* Download button */}
                      <button
                        onClick={() => handleDownloadRawFile(file.name)}
                        className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-700/50 active:bg-zinc-600"
                        title={`Download ${file.name}`}
                      >
                        <Download size={12} className="text-sky-400" />
                      </button>

                      {/* Delete button — disabled for the active (newest, idx===0) file */}
                      <button
                        onClick={() => handleDeleteFile(file.name)}
                        disabled={idx === 0 || deletingFile === file.name}
                        className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-700/50 active:bg-zinc-600 disabled:opacity-30"
                        title={idx === 0 ? 'Cannot delete active file' : `Delete ${file.name}`}
                      >
                        {deletingFile === file.name ? (
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
                        ) : (
                          <Trash2 size={12} className="text-red-400" />
                        )}
                      </button>
                    </div>
                  ))}

                  {deleteFileMutation.isError && (
                    <p className="text-center text-[10px] text-red-400 mt-1">
                      {deleteFileMutation.error?.message ?? 'Delete failed'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** Stat row — matches iOS statRow layout */
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
    <div className="flex items-center justify-between py-0.5">
      <span className="text-zinc-400">{label}</span>
      <span className={`font-mono text-zinc-200 ${capitalize ? 'capitalize' : ''}`}>
        {value}
      </span>
    </div>
  )
}
