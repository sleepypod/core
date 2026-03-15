import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { readdir, stat, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const RAW_DIR = process.env.RAW_DATA_DIR ?? '/persistent'

/** Only allow alphanumeric, dash, underscore, dot — no path separators. */
const SAFE_FILENAME = /^[\w.-]+\.RAW$/i

async function listRawFiles() {
  try {
    const entries = await readdir(RAW_DIR)
    const rawFiles = entries.filter(f => f.toUpperCase().endsWith('.RAW'))

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
      if (!resolved.startsWith(path.resolve(RAW_DIR))) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Path traversal detected' })
      }

      try {
        // Prevent deleting the actively-written (newest) file
        const files = await listRawFiles()
        if (files.length > 0 && files[0].name === input.filename) {
          return { deleted: false, message: 'Cannot delete the active (newest) RAW file' }
        }

        await unlink(resolved)
        return { deleted: true, message: `Deleted ${input.filename}` }
      }
      catch (error) {
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
        // Get partition disk usage
        const { stdout: dfOut } = await execFileAsync('df', ['-B1', RAW_DIR])
        const dfLine = dfOut.trim().split('\n')[1]
        const dfParts = dfLine?.split(/\s+/) ?? []

        const totalBytes = Number(dfParts[1]) || 0
        const usedBytes = Number(dfParts[2]) || 0
        const availableBytes = Number(dfParts[3]) || 0

        // Get RAW-specific usage
        const files = await listRawFiles()
        const rawBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)

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
