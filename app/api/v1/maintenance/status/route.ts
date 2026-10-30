import { maintenanceError, maintenanceStatusResponse, requireMaintenanceStatusAccess } from '@/src/maintenance/statusAccess'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const denied = requireMaintenanceStatusAccess(request)
  if (denied) return denied
  try {
    const { readMaintenanceStatus } = await import('@/src/maintenance/readStatus')
    return maintenanceStatusResponse(request, await readMaintenanceStatus())
  }
  catch { return maintenanceError(503, 'maintenance_status_unavailable') }
}
