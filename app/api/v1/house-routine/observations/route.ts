import { requireAccess } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'
import { houseRoutineObservationsSchema } from '@/src/house-routine/observations'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const denied = requireAccess(request)
  if (denied) return denied
  if (request.method !== 'GET') {
    return privateApiResponse(request, Response.json({ error: 'read_only' }, { status: 405 }))
  }
  if (request.signal.aborted) {
    return privateApiResponse(request, Response.json({ error: 'request_interrupted' }, { status: 408 }))
  }
  if (new URL(request.url).search) {
    return privateApiResponse(request, Response.json({ error: 'observation_request_not_supported' }, { status: 400 }))
  }
  try {
    const { readHouseRoutineObservations } = await import('@/src/house-routine/readObservations')
    const snapshot = houseRoutineObservationsSchema.parse(await readHouseRoutineObservations())
    return privateApiResponse(request, Response.json(snapshot))
  }
  catch {
    return privateApiResponse(request, Response.json({ error: 'qualified_presence_unavailable' }, { status: 503 }))
  }
}
