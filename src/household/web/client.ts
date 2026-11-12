import { ExperimentBrowserProblem, experimentBrowserProblem } from '@/src/comfort/experiments/browserError'
import { PersonalWebError } from './protocol'
import type { HouseholdSession } from '../contract'
import { householdIdSchema } from '../contract'
import { parsePersonalHistorySearch } from '../historyApiContract'
import { maintenancePathAllowed } from './maintenanceProtocol'
import { learningReadPath, learningRemovalPath } from './learningPaths'
import { learningArchiveLimits } from '../learningArchiveContract'
import { personalJournalPath } from './journalPaths'
import { personalQuietPath } from './quietPaths'
import { personalExperimentPath } from './experiments'
import { personalReportPath } from './reportPaths'
export interface PersonalWebTransport {
  read(path: string, method?: 'GET' | 'PUT' | 'POST', body?: unknown): Promise<unknown>
  dispose(): void
}
/** This transport has no owner key, cross-origin destination or legacy API fallback. */
export class PersonalBrowserClient implements PersonalWebTransport {
  private requests = new Set<AbortController>()
  private disposed = false
  constructor(private readonly session: HouseholdSession, private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
  }

  async read(path: string, method: 'GET' | 'PUT' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
    const learningRead = learningReadPath(path, method, body)
    const reportAllowed = personalReportPath(path, method, body)
    let historyRead = false
    if (method === 'GET' && body === undefined && !path.includes('#')) {
      const [pathname, search, extra] = path.split('?')
      try {
        if (pathname === 'me/sleep' && search && extra === undefined) {
          parsePersonalHistorySearch(new URLSearchParams(search))
          historyRead = true
        }
        else if (pathname.startsWith('me/sleep/') && search === undefined) {
          householdIdSchema.parse(pathname.slice('me/sleep/'.length))
          historyRead = true
        }
      }
      catch { /* Unvalidated history paths never reach fetch. */ }
    }
    const allowed = /^(household\/session|household\/arrangement(?:\/(?:approve|cancel|[a-f0-9-]{36}))?|me\/bed|me\/controls(?:\/[a-f0-9-]{36})?|me\/routines(?:\/(?:review|publish|publications\/[a-f0-9-]{36}))?)$/
    const allowedMethod = method === 'GET'
      ? !['me/controls', 'me/routines/publish', 'household/arrangement/approve', 'household/arrangement/cancel'].includes(path)
      : method === 'PUT' ? path === 'me/routines' : ['me/controls', 'me/routines/publish', 'household/arrangement', 'household/arrangement/approve', 'household/arrangement/cancel'].includes(path)
    if (this.disposed || (!personalExperimentPath(path, method, body) && !reportAllowed && !learningRead && !learningRemovalPath(path, method, body) && !historyRead && !personalJournalPath(path, method, body) && !personalQuietPath(path, method, body) && !maintenancePathAllowed(path, method, body) && (!allowed.test(path) || !allowedMethod)))
      throw new PersonalWebError('account_changed', 'Reconnect the personal workspace before continuing.')
    const controller = new AbortController()
    this.requests.add(controller)
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await this.fetcher(`/api/v1/${path}`, { method, cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal,
        headers: { 'X-Sleepypod-Sleeper-Id': this.session.selfSleeperId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      // Bound a streamed body, not just a content-length supplied by the peer.
      const reader = response.body?.getReader()
      if (!reader)
        throw new PersonalWebError('invalid', 'The controller returned an empty response.')
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        const next = await reader.read()
        if (next.done)
          break
        length += next.value.length
        const maximumBytes = learningRead === 'detail' ? 2 * learningArchiveLimits.recordBytes + 64 * 1024 : 524288
        if (length > maximumBytes) {
          await reader.cancel()
          throw new PersonalWebError('invalid', 'The controller response was too large.')
        }
        chunks.push(next.value)
      }
      if (this.disposed)
        throw new PersonalWebError('account_changed', 'The personal account changed.')
      if (!response.ok && personalExperimentPath(path, method, body)) {
        const joined = new Uint8Array(length)
        let position = 0
        for (const chunk of chunks) {
          joined.set(chunk, position)
          position += chunk.length
        }
        throw experimentBrowserProblem(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)))
      }
      if (!response.ok) {
        const code = [401, 403].includes(response.status) ? 'authentication' : response.status === 409 ? 'conflict' : response.status === 404 ? 'missing' : 'unavailable'
        throw new PersonalWebError(code, code === 'authentication'
          ? 'Reconnect your personal account.'
          : code === 'conflict'
            ? 'The account, assignment or saved plan changed. Refresh and review again.'
            : code === 'missing' ? 'No receipt is available yet. Its outcome remains uncertain; nothing was resent.' : 'The personal controller is unavailable. Check the saved result before trying again.')
      }
      const buffer = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        buffer.set(chunk, offset)
        offset += chunk.length
      }
      return JSON.parse(new TextDecoder().decode(buffer))
    }
    catch (error) {
      if (error instanceof PersonalWebError || error instanceof ExperimentBrowserProblem)
        throw error
      throw new PersonalWebError('uncertain', 'The response could not be confirmed. Check its saved result; the request will not be resent.')
    }
    finally {
      clearTimeout(timeout)
      this.requests.delete(controller)
    }
  }

  dispose() {
    this.disposed = true
    for (const request of this.requests)
      request.abort()
    this.requests.clear()
  }
}
