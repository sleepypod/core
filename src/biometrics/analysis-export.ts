import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ARCHIVE_DIR } from '@/src/lib/podStorage'

export const ANALYSIS_EXPORT_FORMAT = 'analysis-export-v1'
export const ANALYSIS_EXPORT_PATH = '/api/biometrics/analysis-export'
export const MAX_ANALYSIS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
export const MAX_ANALYSIS_RAW_BYTES = 2 * 1024 ** 3
// A frame's archive is written ~15 min after the frame closes, so a frame that
// starts just before the window is stamped up to 20 min later, and the last
// frame of the window up to 45 min after its end.
export const RAW_MTIME_LEAD_MS = 20 * 60 * 1000
export const RAW_MTIME_LAG_MS = 45 * 60 * 1000

// Only finished archives: the archiver writes <name>.RAW.gz.tmp.<pid> and renames.
const ARCHIVE_NAME = /^[A-Za-z0-9_-]+\.RAW\.gz$/

const instant = z.string().trim().min(1).max(40)
export const analysisExportRequestSchema = z.object({ start: instant, end: instant, includeRaw: z.boolean().default(true) }).strict()
export type AnalysisExportRequest = z.input<typeof analysisExportRequestSchema>

/** Start/end as epoch ms or ISO 8601, start < end, at most 14 days apart. */
export const analysisWindowSchema = analysisExportRequestSchema.transform((input, ctx) => {
  const toMs = (value: string, key: 'start' | 'end') => {
    const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
    if (Number.isSafeInteger(ms) && ms >= 0) return ms
    ctx.addIssue({ code: 'custom', path: [key], message: `${key} must be an ISO 8601 timestamp or epoch milliseconds` })
    return null
  }
  const startMs = toMs(input.start, 'start'), endMs = toMs(input.end, 'end')
  if (startMs === null || endMs === null) return z.NEVER
  if (startMs >= endMs) ctx.addIssue({ code: 'custom', path: ['end'], message: 'start must be before end' })
  else if (endMs - startMs > MAX_ANALYSIS_WINDOW_MS) ctx.addIssue({ code: 'custom', path: ['end'], message: 'The window must be 14 days or shorter' })
  return { startMs, endMs, includeRaw: input.includeRaw }
})
export type AnalysisWindow = z.output<typeof analysisWindowSchema>

export class AnalysisExportTooLargeError extends Error {
  constructor(readonly rawBytes: number, readonly archiveCount: number) {
    super(`The window holds ${archiveCount} RAW archives totalling ${rawBytes} bytes, over the ${MAX_ANALYSIS_RAW_BYTES}-byte limit. Narrow the window or pass raw=0.`)
  }
}

export interface WindowArchive { name: string, path: string, bytes: number, mtimeMs: number }

/** Finished RAW archives whose mtime falls in [start − 20 min, end + 45 min], oldest first. */
export async function listWindowArchives(window: Pick<AnalysisWindow, 'startMs' | 'endMs'>, directory = ARCHIVE_DIR): Promise<WindowArchive[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const from = window.startMs - RAW_MTIME_LEAD_MS, to = window.endMs + RAW_MTIME_LAG_MS
  const archives: WindowArchive[] = []
  for (const name of names) {
    if (!ARCHIVE_NAME.test(name)) continue
    const path = join(directory, name)
    // The pruner may delete an archive between readdir and lstat.
    const info = await lstat(path).catch(() => null)
    if (!info?.isFile()) continue
    const mtimeMs = Math.floor(info.mtimeMs)
    if (mtimeMs < from || mtimeMs > to) continue
    archives.push({ name, path, bytes: info.size, mtimeMs })
  }
  return archives.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
}

/** Archives to send for a window; throws AnalysisExportTooLargeError over the cap. */
export async function planAnalysisExport(window: AnalysisWindow, directory = ARCHIVE_DIR) {
  const archives = window.includeRaw ? await listWindowArchives(window, directory) : []
  const rawBytes = archives.reduce((sum, archive) => sum + archive.bytes, 0)
  if (rawBytes > MAX_ANALYSIS_RAW_BYTES) throw new AnalysisExportTooLargeError(rawBytes, archives.length)
  return { window, archives, rawBytes }
}

/** Live database plus its WAL: an upper bound for the size of its backup. */
export async function liveDatabaseBytes(file: string) {
  const sizes = await Promise.all([file, `${file}-wal`].map(name => stat(name).then(info => info.size, () => 0)))
  return sizes[0] + sizes[1]
}

/** Uncompressed ustar size: a header per entry, 512-byte padding, two end blocks. */
export function tarBytes(entryBytes: readonly number[]) {
  return entryBytes.reduce((sum, bytes) => sum + 512 + Math.ceil(bytes / 512) * 512, 1024)
}

export function analysisExportDownloadPath(window: AnalysisWindow) {
  return `${ANALYSIS_EXPORT_PATH}?start=${window.startMs}&end=${window.endMs}&raw=${window.includeRaw ? 1 : 0}`
}
