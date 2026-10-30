import { authConfigured, validOwnerToken } from '@/src/auth/access'
import { maintenanceStatusSchema, type MaintenanceStatus } from './statusContract'

const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization, Cookie, Origin', 'Content-Type': 'application/json' }

export function maintenanceError(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers })
}

/** This administrative read accepts only a CLI bearer; no browser or personal session. */
export function requireMaintenanceStatusAccess(request: Request): Response | null {
  if (!['GET', 'HEAD'].includes(request.method)) return maintenanceError(405, 'read_only')
  const authorization = request.headers.get('authorization')
  if (request.headers.has('cookie') || request.headers.has('origin') || request.headers.has('sec-fetch-site')
    || !authorization?.startsWith('Bearer ') || !validOwnerToken(authorization.slice(7))) {
    return maintenanceError(authConfigured() ? 401 : 503, 'administrative_bearer_required')
  }
  if (new URL(request.url).search) return maintenanceError(400, 'parameters_not_supported')
  if (request.signal.aborted) return maintenanceError(499, 'request_interrupted')
  return null
}

/** A single lazy output chunk rechecks key rotation/abort immediately before delivery. */
export function maintenanceStatusResponse(request: Request, snapshot: MaintenanceStatus): Response {
  const denied = requireMaintenanceStatusAccess(request)
  if (denied) return denied
  const payload = JSON.stringify(maintenanceStatusSchema.parse(snapshot))
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (requireMaintenanceStatusAccess(request)) {
        controller.error(new Error('Maintenance access changed before delivery'))
        return
      }
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  }, { highWaterMark: 0 }), { headers })
}
