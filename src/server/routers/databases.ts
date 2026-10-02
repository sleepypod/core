import { dirname } from 'node:path'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import type Database from 'better-sqlite3'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, sqlite } from '@/src/db'
import { getDatabaseIntegrityByDb } from '@/src/db/integrity'
import { configuredRetentionDays, RETAINED_TABLE_NAMES } from '@/src/db/retention'
import { AUTOMATION_RUNS_TABLE_NAME, configuredAutomationRunsRetentionDays } from '@/src/db/automationRunsRetention'
import { CAP_FRAMES_RETENTION_MS } from '@/src/streaming/capFramePersistence'
import { dfPosix } from '@/src/lib/podStorage'
import {
  DB_FILES, TIME_COLUMNS, inspectDatabases, lastBackupAt, manualIntegrity, migrationInfo, runIntegrityChecks,
  type DbKey,
} from '@/src/lib/dbInspect'

const dbKey = z.enum(['sleepypod', 'biometrics'])

const integrityRun = z.object({
  status: z.enum(['pending', 'ok', 'degraded']),
  checkedAt: z.string().nullable(),
  latencyMs: z.number(),
  error: z.string().optional(),
})

/** Who prunes each table, and to how long. Anything missing here is kept forever. */
function retentionFor(key: DbKey, table: string): { days: number, by: string } | null {
  if (key === 'sleepypod') {
    return table === AUTOMATION_RUNS_TABLE_NAME ? { days: configuredAutomationRunsRetentionDays(), by: 'automation runs retention pass' } : null
  }
  if (RETAINED_TABLE_NAMES.includes(table)) return { days: configuredRetentionDays(), by: 'daily retention pass' }
  if (table === 'cap_sense_frames') return { days: CAP_FRAMES_RETENTION_MS / 86_400_000, by: 'cap frame writer' }
  return null
}

function connection(key: DbKey): Database.Database {
  return key === 'sleepypod' ? sqlite : biometricsDb.$client
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

// Never echo credentials through the row browser.
const SECRET_COLUMN = /password|secret|token|api_?key/i

function cell(column: string, v: unknown): string | number | null {
  if (v == null) return null
  if (SECRET_COLUMN.test(column)) return '••••'
  if (typeof v === 'number' || typeof v === 'string') return v
  if (typeof v === 'bigint') return v.toString()
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`
  return String(v)
}

/**
 * System → Databases: both SQLite files side by side — integrity, WAL, size,
 * retention, per-table rows and writes, migrations — plus a read-only row
 * browser. Backups download from /api/db-backup.
 */
export const databasesRouter = router({
  overview: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/databases', protect: false, tags: ['System'] } })
    .input(z.object({ fresh: z.boolean().default(false) }))
    .output(z.object({
      at: z.number(),
      hoursFrom: z.number(),
      dataDir: z.string(),
      disk: z.object({ totalBytes: z.number(), availableBytes: z.number() }).nullable(),
      lastBackupAt: z.number().nullable(),
      occupiedHours: z.array(z.number()),
      databases: z.array(z.object({
        key: dbKey,
        path: z.string(),
        fileBytes: z.number(),
        walBytes: z.number(),
        pageSize: z.number(),
        freePages: z.number(),
        walAutocheckpoint: z.number(),
        error: z.string().optional(),
        integrity: z.object({
          /** The hourly background check. */
          scheduled: integrityRun.nullable(),
          /** The last on-demand check from this page, since the server started. */
          manual: integrityRun.nullable(),
        }),
        migrations: z.object({
          applied: z.number(),
          known: z.number(),
          latestTag: z.string().nullable(),
          appliedTag: z.string().nullable(),
        }),
        tables: z.array(z.object({
          name: z.string(),
          rows: z.number(),
          bytes: z.number(),
          timeColumn: z.string().nullable(),
          timeInMs: z.boolean(),
          lastWriteAt: z.number().nullable(),
          oldestAt: z.number().nullable(),
          hourly: z.array(z.number()),
          rows24h: z.number(),
          retention: z.object({ days: z.number(), by: z.string() }).nullable(),
        })),
      })),
    }))
    .query(async ({ input }) => {
      try {
        const scan = await inspectDatabases(input.fresh)
        const dataDir = dirname(DB_FILES.sleepypod.path)
        const [disk, backupAt] = await Promise.all([dfPosix(dataDir), lastBackupAt()])
        const manual = manualIntegrity()
        const scheduled = getDatabaseIntegrityByDb()
        const databases = await Promise.all(scan.databases.map(async (d) => {
          const mig = await migrationInfo(d.key, d.lastMigrationAt)
          return {
            key: d.key,
            path: d.path,
            fileBytes: d.fileBytes,
            walBytes: d.walBytes,
            pageSize: d.pageSize,
            freePages: d.freePages,
            walAutocheckpoint: d.walAutocheckpoint,
            ...(d.error && { error: d.error }),
            integrity: {
              scheduled: scheduled[d.key],
              manual: manual[d.key] ?? null,
            },
            migrations: { applied: d.appliedMigrations, ...mig },
            tables: d.tables.map(t => ({ ...t, retention: retentionFor(d.key, t.name) })),
          }
        }))
        return {
          at: scan.at,
          hoursFrom: scan.hoursFrom,
          dataDir,
          disk: disk && disk.totalBytes > 0 ? { totalBytes: disk.totalBytes, availableBytes: disk.availableBytes } : null,
          lastBackupAt: backupAt,
          occupiedHours: scan.occupiedHours,
          databases,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to inspect databases: ${error instanceof Error ? error.message : 'unknown error'}`,
          cause: error,
        })
      }
    }),

  /** quick_check both databases now, without waiting for the hourly check. */
  checkIntegrity: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/system/databases/integrity', protect: false, tags: ['System'] } })
    .input(z.object({}))
    .output(z.object({ sleepypod: integrityRun.optional(), biometrics: integrityRun.optional() }))
    .mutation(async () => {
      try {
        return await runIntegrityChecks()
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Integrity check failed to run: ${error instanceof Error ? error.message : 'unknown error'}`,
          cause: error,
        })
      }
    }),

  /** One page of a table, newest rows first, optionally filtered by column = value. */
  rows: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/databases/rows', protect: false, tags: ['System'] } })
    .input(z.object({
      db: dbKey,
      table: z.string().min(1).max(128),
      column: z.string().min(1).max(128).optional(),
      value: z.string().max(256).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(8),
    }))
    .output(z.object({
      columns: z.array(z.string()),
      timeColumn: z.string().nullable(),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
      total: z.number(),
    }))
    .query(({ input }) => {
      const conn = connection(input.db)
      const known = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(input.table)
      if (!known) throw new TRPCError({ code: 'NOT_FOUND', message: `No table ${input.table} in ${input.db}.db` })
      const columns = (conn.prepare(`PRAGMA table_info(${quote(input.table)})`).all() as Array<{ name: string }>).map(c => c.name)
      const filtered = input.column != null && input.value != null
      if (filtered && !columns.includes(input.column as string)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `No column ${input.column} in ${input.table}` })
      }
      const where = filtered ? ` WHERE ${quote(input.column as string)} = ?` : ''
      const args = filtered ? [input.value] : []
      const total = (conn.prepare(`SELECT COUNT(*) AS n FROM ${quote(input.table)}${where}`).get(...args) as { n: number }).n
      const raw = conn.prepare(`SELECT * FROM ${quote(input.table)}${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
        .all(...args, input.limit, input.offset) as Array<Record<string, unknown>>
      return {
        columns,
        timeColumn: TIME_COLUMNS.find(c => columns.includes(c)) ?? null,
        rows: raw.map(r => columns.map(c => cell(c, r[c]))),
        total,
      }
    }),
})
