import type Database from 'better-sqlite3'
import { requireAccess } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'
import { legacyExperimentAccess } from './access'
import { experimentErrorResponse, experimentResponse, readExperimentBody } from './http'
import { ComfortExperimentService } from './service'

const shared = globalThis as typeof globalThis & { __sleepypodExperiments?: WeakMap<Database.Database, ComfortExperimentService> }
export function getComfortExperiments(database: Database.Database) {
  const services = shared.__sleepypodExperiments ??= new WeakMap()
  let service = services.get(database)
  if (!service) {
    service = new ComfortExperimentService(database)
    services.set(database, service)
  }
  return service
}

/** Owner access uses the same durable legacy boundary as reports; personal accounts use /me instead. */
export async function handleOwnerExperimentRequest(request: Request): Promise<Response> {
  const denied = requireAccess(request)
  if (denied) return denied
  if (request.signal.aborted) return privateApiResponse(request, new Response(null))
  try {
    const body = request.method === 'POST' ? await readExperimentBody(request) : undefined
    const { sqlite } = await import('@/src/db')
    const authorize = () => {
      const changed = requireAccess(request)
      if (changed) throw changed
      return legacyExperimentAccess(sqlite)
    }
    return privateApiResponse(request, experimentResponse(request, body, getComfortExperiments(sqlite), authorize))
  }
  catch (error) { return privateApiResponse(request, error instanceof Response ? error : experimentErrorResponse(error)) }
}
