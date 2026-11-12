import { requireAccess } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'
import { readReportBody, reportErrorResponse, reportResponse } from './http'
import { MorningReportStore } from './store'

const shared = globalThis as typeof globalThis & { __sleepypodMorningReports?: MorningReportStore }

/** Owner reports remain a legacy-only surface; the persistent personal boundary also applies here. */
export async function handleOwnerReportRequest(request: Request): Promise<Response> {
  const denied = requireAccess(request)
  if (denied) return denied
  if (request.signal.aborted) return privateApiResponse(request, new Response(null))
  try {
    const body = ['PUT', 'DELETE'].includes(request.method) ? await readReportBody(request) : undefined
    const [{ sqlite }, { readConnectionIdentity }] = await Promise.all([import('@/src/db'), import('@/src/connections/read')])
    const assertAccess = () => {
      const changed = requireAccess(request)
      if (changed) throw changed
      const identity = { kind: 'legacy' as const, installationId: readConnectionIdentity() }
      return { identity, scope: identity }
    }
    const store = shared.__sleepypodMorningReports ??= new MorningReportStore(sqlite)
    return privateApiResponse(request, reportResponse(request, body, store, assertAccess))
  }
  catch (error) { return privateApiResponse(request, error instanceof Response ? error : reportErrorResponse(error)) }
}
