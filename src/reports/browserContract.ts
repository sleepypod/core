import { z } from 'zod'
import { parseMorningReport, reportIdSchema, type SavedMorningReport } from './morning'

const clock = z.number().int().nonnegative().max(253402300799999)
export const reportBrowserScope = z.union([
  z.object({ kind: z.literal('legacy'), installationId: reportIdSchema }).strict(),
  z.object({ podId: reportIdSchema, householdId: reportIdSchema, accountId: reportIdSchema, sleeperId: reportIdSchema,
    sessionRevision: z.number().int().positive(), householdRevision: z.number().int().positive(), assignmentRevision: z.number().int().positive() }).strict(),
])
export type ReportBrowserScope = z.infer<typeof reportBrowserScope>
const receipt = z.object({ id: reportIdSchema, revision: reportIdSchema, deleted: z.boolean(), createdAt: clock.nullable(),
  receivedAt: clock, updatedAt: clock }).strict()
export const reportMetadata = receipt.extend({ provider: z.enum(['apple', 'openai', 'gemini', 'anthropic', 'ollama']),
  model: z.string().min(1).max(128), source: z.string().min(1).max(256) }).strict()
export type ReportMetadata = z.infer<typeof reportMetadata>
const envelope = z.object({ version: z.literal(1), generatedAt: clock, scope: reportBrowserScope })
const list = envelope.extend({ reports: z.array(reportMetadata).max(100) }).strict()
const detail = envelope.extend({ receipt, report: z.unknown().nullable() }).strict()
export const sameReportScope = (first: ReportBrowserScope, second: ReportBrowserScope) => {
  const left = reportBrowserScope.parse(first), right = reportBrowserScope.parse(second)
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Validate the authenticated envelope before exposing any saved prose or metadata. */
export function readReportLibrary(input: unknown, scope: ReportBrowserScope, now: number) {
  const page = list.parse(input)
  if (!sameReportScope(page.scope, scope) || page.generatedAt > now + 60000
    || new Set(page.reports.map(report => report.id)).size !== page.reports.length
    || page.reports.some(report => report.deleted || report.createdAt === null || !validReceipt(report, page.generatedAt)))
    throw new Error('The shared report library could not be verified.')
  return page
}

export function readReportCopy(input: unknown, scope: ReportBrowserScope, id: string, now: number) {
  const page = detail.parse(input)
  if (!sameReportScope(page.scope, scope) || page.generatedAt > now + 60000 || page.receipt.id !== reportIdSchema.parse(id)
    || !validReceipt(page.receipt, page.generatedAt) || page.receipt.deleted !== (page.report === null))
    throw new Error('The shared report copy could not be verified.')
  let report: SavedMorningReport | null = null
  if (!page.receipt.deleted) {
    report = parseMorningReport(JSON.stringify({ version: 1, report: page.report }), page.generatedAt)
    if (report.id !== page.receipt.id || report.createdAt !== page.receipt.createdAt) throw new Error('Report identity changed.')
  }
  return { ...page, report }
}

function validReceipt(value: z.infer<typeof receipt>, generatedAt: number) {
  return (value.createdAt === null ? value.deleted : value.createdAt <= value.receivedAt)
    && value.receivedAt <= value.updatedAt && value.updatedAt <= generatedAt
}
