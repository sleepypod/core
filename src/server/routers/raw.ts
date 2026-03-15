import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { lstat, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const RAW_DIR = process.env.RAW_DATA_DIR ?? '/persistent'

/** Only allow alphanumeric, dash, underscore, dot — no path separators. */
const SAFE_FILENAME = /^[\w.-]+\.RAW$/i

export async function listRawFiles() {
  try {
    const entries = await readdir(RAW_DIR)
    const rawFiles = entries.filter(f => SAFE_FILENAME.test(f))

    const results = await Promise.all(rawFiles.map(async (name) => {
      const s = await stat(path.join(RAW_DIR, name))
      return {
        name,
        sizeBytes: s.size,
        modifiedAt: s.mtime.toISOString(),
      }
    }))

    // Sort newest first
    results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    return results
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export const rawRouter = router({
  files: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/raw/files', protect: false, tags: ['Raw'] } })
    .input(z.object({}))
    .output(z.any())
    .query(async () => {
      try {
        return await listRawFiles()
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to list RAW files: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  deleteFile: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/raw/files/delete', protect: true, tags: ['Raw'] } })
    .input(z.object({ filename: z.string() }).strict())
    .output(z.object({ deleted: z.boolean(), message: z.string() }))
    .mutation(async ({ input }) => {
      if (!SAFE_FILENAME.test(input.filename)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid filename' })
      }

      const resolved = path.resolve(RAW_DIR, input.filename)

      try {
        // Reject symlinks and verify canonical path (matches download route)
        const lstats = await lstat(resolved)
        if (lstats.isSymbolicLink()) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Path traversal detected' })
        }
        const canonicalFile = await realpath(resolved)
        const canonicalDir = await realpath(RAW_DIR)
        if (!canonicalFile.startsWith(canonicalDir)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Path traversal detected' })
        }

        // Prevent deleting the actively-written (newest) file
        const files = await listRawFiles()
        if (files.length > 0 && files[0].name === input.filename) {
          return { deleted: false, message: 'Cannot delete the active (newest) RAW file' }
        }

        await unlink(resolved)
        return { deleted: true, message: `Deleted ${input.filename}` }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { deleted: false, message: 'File not found' }
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  diskUsage: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/raw/disk-usage', protect: false, tags: ['Raw'] } })
    .input(z.object({}))
    .output(z.any())
    .query(async () => {
      try {
        const files = await listRawFiles()
        const rawBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)

        // df -B1 is GNU coreutils (Linux only); fall back gracefully on macOS/dev
        let totalBytes = 0
        let usedBytes = 0
        let availableBytes = 0
        try {
          const { stdout: dfOut } = await execFileAsync('df', ['-B1', RAW_DIR], { timeout: 5000 })
          const dfLine = dfOut.trim().split('\n')[1]
          const dfParts = dfLine?.split(/\s+/) ?? []
          totalBytes = Number(dfParts[1]) || 0
          usedBytes = Number(dfParts[2]) || 0
          availableBytes = Number(dfParts[3]) || 0
        }
        catch {
          // df unavailable (macOS dev environment) — return file stats only
        }

        return {
          totalBytes,
          usedBytes,
          availableBytes,
          rawFileCount: files.length,
          rawBytes,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to get disk usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
