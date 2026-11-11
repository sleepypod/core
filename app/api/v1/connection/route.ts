import { requireAccess } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'
import { connectionChallengeSchema, connectionIdentitySchema } from '@/src/connections/identity'

export const dynamic = 'force-dynamic'

/** Authenticated installation identity, bound to this fresh client challenge rather than a cached capability reply. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAccess(request)
  if (denied) return denied
  if (request.signal.aborted) return privateApiResponse(request, new Response(null))
  const query = new URL(request.url).searchParams
  const challenge = connectionChallengeSchema.safeParse(query.get('challenge'))
  if (!challenge.success || query.size !== 1) {
    return privateApiResponse(request, Response.json({ error: 'A single 43-character base64url challenge is required' }, { status: 400 }))
  }
  try {
    const { readConnectionIdentity } = await import('@/src/connections/read')
    // Recheck after loading the database; a personal boundary can close owner access in the meantime.
    const changed = requireAccess(request)
    if (changed) return privateApiResponse(request, changed)
    if (request.signal.aborted) return privateApiResponse(request, new Response(null))
    const identity = connectionIdentitySchema.parse({
      schemaVersion: 1, controller: 'sleepypod-core', installationId: readConnectionIdentity(), challenge: challenge.data,
    })
    return privateApiResponse(request, Response.json(identity))
  }
  catch {
    return privateApiResponse(request, Response.json({ error: 'Controller connection identity is unavailable' }, { status: 503 }))
  }
}
