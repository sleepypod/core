import { z } from 'zod'
import { parseMorningReport, reportIdSchema } from '@/src/reports/morning'

/** Browser questions may append to an existing personal report, never upload into the owner's scope. */
export function personalReportPath(path: string, method: string, body: unknown): boolean {
  if (method === 'GET' && body === undefined && path === 'me/reports') return true
  if (!path.startsWith('me/reports/')) return false
  const parsed = reportIdSchema.safeParse(path.slice('me/reports/'.length))
  if (!parsed.success) return false
  if (method === 'GET') return body === undefined
  if (method !== 'PUT') return false
  try {
    const request = z.object({ expectedRevision: reportIdSchema, document: z.unknown() }).strict().parse(body)
    const report = parseMorningReport(JSON.stringify(request.document), Date.now())
    return report.id === parsed.data && (report.followUps?.length ?? 0) > 0
  }
  catch { return false }
}
