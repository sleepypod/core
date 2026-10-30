import { requireAccess } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const denied = requireAccess(request)
  if (denied) return denied
  const { capabilitiesRouter } = await import('@/src/server/routers/capabilities')
  return privateApiResponse(request, Response.json(await capabilitiesRouter.createCaller({}).get({}), {
    headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization, Cookie' },
  }))
}
