import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { parseMorningReport, reportIdSchema, type SavedMorningReport } from './morning'

const identifier = z.uuid().transform(value => value.toLowerCase())
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacy'), installationId: identifier }).strict(),
  z.object({ kind: z.literal('personal'), podId: identifier, householdId: identifier, accountId: identifier, sleeperId: identifier }).strict(),
])
export type ReportScope = z.infer<typeof scopeSchema>
export class ReportError extends Error {
  constructor(readonly code: 'invalid_request' | 'conflict' | 'not_found' | 'capacity' | 'unavailable', readonly status: number, message: string) {
    super(message)
  }
}
interface ReportRow {
  scope_key: string
  report_id: string
  created_at: number | null
  received_at: number
  updated_at: number
  revision: string
  original_hash: string | null
  document_hash: string | null
  payload: string | null
  deleted_at: number | null
}
export interface ReportReceipt {
  id: string
  revision: string
  deleted: boolean
  createdAt: number | null
  receivedAt: number
  updatedAt: number
}

/** Stable object ordering makes retries independent of a client's JSON field order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const originalHash = (report: SavedMorningReport) => digest(canonical({ ...report, followUps: undefined }))
const receipt = (row: ReportRow): ReportReceipt => ({ id: row.report_id, revision: row.revision, deleted: row.deleted_at !== null,
  createdAt: row.created_at, receivedAt: row.received_at, updatedAt: row.updated_at })
const conflict = () => new ReportError('conflict', 409, 'This report changed. Refresh its saved version before continuing.')

/** Scope is supplied only by server authentication. This store never sends evidence to an AI or changes the bed. */
export class MorningReportStore {
  constructor(private readonly database: Database.Database, private readonly now = Date.now) {}

  private key(scope: ReportScope) { return canonical(scopeSchema.parse(scope)) }
  private row(scopeKey: string, reportId: string) {
    return this.database.prepare('SELECT * FROM morning_reports WHERE scope_key = ? AND report_id = ?').get(scopeKey, reportId) as ReportRow | undefined
  }

  private decode(row: ReportRow): SavedMorningReport {
    try {
      if (!row.payload || digest(row.payload) !== row.document_hash) throw new Error('Changed payload')
      const report = parseMorningReport(row.payload, this.now())
      if (report.id !== row.report_id || report.createdAt !== row.created_at || originalHash(report) !== row.original_hash
        || !identifier.safeParse(row.revision).success || row.received_at < report.createdAt || row.updated_at < row.received_at || row.updated_at > this.now())
        throw new Error('Changed metadata')
      return report
    }
    catch { throw new ReportError('unavailable', 503, 'This saved report needs review before it can be displayed.') }
  }

  list(scope: ReportScope) {
    const rows = this.database.prepare('SELECT * FROM morning_reports WHERE scope_key = ? AND deleted_at IS NULL ORDER BY created_at DESC, report_id DESC LIMIT 100')
      .all(this.key(scope)) as ReportRow[]
    return rows.map((row) => {
      const report = this.decode(row)
      return { ...receipt(row), provider: report.provider, model: report.model, source: report.source }
    })
  }

  read(scope: ReportScope, reportId: string) {
    const row = this.row(this.key(scope), reportIdSchema.parse(reportId))
    if (!row) throw new ReportError('not_found', 404, 'This report is not in your shared library.')
    return { receipt: receipt(row), report: row.deleted_at === null ? this.decode(row) : null }
  }

  /** Original evidence is immutable; a conditional update may only append dated answers. */
  save(scope: ReportScope, reportId: string, document: unknown, expectedRevision: string | null): ReportReceipt {
    const scopeKey = this.key(scope), identity = reportIdSchema.parse(reportId)
    const revision = identifier.nullable().parse(expectedRevision), now = this.now()
    let report: SavedMorningReport
    try {
      report = parseMorningReport(JSON.stringify(document), now)
    }
    catch { throw new ReportError('invalid_request', 400, 'The report dates, evidence or document format are invalid.') }
    if (report.id !== identity) throw new ReportError('invalid_request', 400, 'The report ID does not match its destination.')
    const payload = canonical({ version: 1, report }), documentHash = digest(payload)
    return this.database.transaction(() => {
      const current = this.row(scopeKey, identity)
      if (current && current.deleted_at !== null)
        throw new ReportError('conflict', 409, 'This shared report was deleted and cannot be restored by a delayed sync.')
      if (current) {
        const previous = this.decode(current)
        if (current.document_hash === documentHash) return receipt(current)
        const oldAnswers = previous.followUps ?? [], newAnswers = report.followUps ?? []
        if (current.revision !== revision || current.original_hash !== originalHash(report) || newAnswers.length <= oldAnswers.length
          || oldAnswers.some((answer, index) => canonical(answer) !== canonical(newAnswers[index])) || now < current.updated_at) throw conflict()
        this.database.prepare('UPDATE morning_reports SET payload = ?, document_hash = ?, updated_at = ?, revision = ? WHERE scope_key = ? AND report_id = ?')
          .run(payload, documentHash, now, randomUUID(), scopeKey, identity)
      }
      else {
        if (revision !== null) throw conflict()
        this.checkCapacity(scopeKey, true)
        this.database.prepare(`INSERT INTO morning_reports
          (scope_key, report_id, created_at, received_at, updated_at, revision, original_hash, document_hash, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scopeKey, identity, report.createdAt, now, now, randomUUID(), originalHash(report), documentHash, payload)
      }
      const saved = this.row(scopeKey, identity)
      if (!saved) throw new Error('Report transaction failed')
      return receipt(saved)
    }).immediate()
  }

  /** An unseen ID may be withdrawn before an in-flight upload arrives. Tombstones never contain report text. */
  remove(scope: ReportScope, reportId: string, expectedRevision: string | null): ReportReceipt {
    const scopeKey = this.key(scope), identity = reportIdSchema.parse(reportId), revision = identifier.nullable().parse(expectedRevision)
    return this.database.transaction(() => {
      const current = this.row(scopeKey, identity), now = this.now()
      if (current && current.deleted_at !== null) return receipt(current)
      if (current) {
        if (current.revision !== revision || now < current.updated_at) throw conflict()
        this.database.prepare(`UPDATE morning_reports SET payload = NULL, original_hash = NULL, document_hash = NULL,
          deleted_at = ?, updated_at = ?, revision = ? WHERE scope_key = ? AND report_id = ?`).run(now, now, randomUUID(), scopeKey, identity)
      }
      else {
        if (revision !== null) throw conflict()
        this.checkCapacity(scopeKey, false)
        this.database.prepare(`INSERT INTO morning_reports (scope_key, report_id, received_at, updated_at, revision, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(scopeKey, identity, now, now, randomUUID(), now)
      }
      const saved = this.row(scopeKey, identity)
      if (!saved) throw new Error('Report deletion failed')
      return receipt(saved)
    }).immediate()
  }

  private checkCapacity(scopeKey: string, addingReport: boolean) {
    const counts = this.database.prepare('SELECT COUNT(*) AS total, SUM(deleted_at IS NULL) AS active FROM morning_reports WHERE scope_key = ?')
      .get(scopeKey) as { total: number, active: number | null }
    if (counts.total >= 1000 || (addingReport && (counts.active ?? 0) >= 100))
      throw new ReportError('capacity', 409, 'The shared report library is full. Keep a private export before reviewing its storage.')
  }
}
