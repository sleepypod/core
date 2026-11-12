import { experimentBrowserProblem } from './browserError'
import { z } from 'zod'
import { ComfortExperimentBrowserWorkspace } from './browserWorkspace'
import { experimentBrowserRequest } from './browserContract'
import { experimentExecutionBrowserRequest } from './browserExecution'
const owner = z.object({ configured: z.literal(true), authenticated: z.literal(true), privacyAvailable: z.literal(true),
  personalSessionActive: z.literal(false), personalConnectionRequired: z.literal(false), browserScopeRevision: z.string().min(1).max(256) })
const connection = z.object({ schemaVersion: z.literal(1), controller: z.literal('sleepypod-core'), installationId: z.string().uuid(), challenge: z.string() }).strict()
/** Same-origin owner cookies; fixed comparison actions, never arbitrary actuator endpoints. */
export function ownerExperimentWorkspace(fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
  const request = async (path: string, method: 'GET' | 'POST', body: unknown, signal: AbortSignal): Promise<unknown> => {
    const response = await fetcher(path, { method, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    const reader = response.body?.getReader()
    if (!reader || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      await reader?.cancel()
      throw new Error('Experiment request failed.')
    }
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done)
          break
        bytes += chunk.value.byteLength
        if (bytes > 524288 || signal.aborted)
          throw new Error('Experiment response interrupted or too large.')
        chunks.push(chunk.value)
      }
      if (signal.aborted)
        throw new Error('Experiment response interrupted.')
      const output = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output))
      if (!response.ok) throw experimentBrowserProblem(value)
      return value
    }
    finally {
      await reader.cancel().catch(() => { })
      reader.releaseLock()
    }
  }
  return new ComfortExperimentBrowserWorkspace({
    async access(signal) {
      const session = owner.parse(await request('/api/auth/session', 'GET', undefined, signal))
      const challenge = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('')
      const identity = connection.parse(await request(`/api/v1/connection?challenge=${challenge}`, 'GET', undefined, signal))
      if (identity.challenge !== challenge)
        throw new Error('Controller identity changed.')
      return { scope: { kind: 'legacy', installationId: identity.installationId }, revision: session.browserScopeRevision, execution: true }
    },
    request(path, method, body, signal) {
      if (!experimentBrowserRequest(path, method, body) && !experimentExecutionBrowserRequest(path, method, body))
        throw new Error('Invalid comparison request.')
      return request(`/api/v1/comfort/experiments${path.startsWith('?') || !path ? path : `/${path}`}`, method, body, signal)
    },
  })
}
