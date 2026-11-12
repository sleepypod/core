import { z } from 'zod'
import { MorningReportBrowserWorkspace, type ReportBrowserTransport } from './browserWorkspace'
import { reportIdSchema } from './morning'

const browserSession = z.object({ configured: z.literal(true), authenticated: z.literal(true), privacyAvailable: z.literal(true),
  personalSessionActive: z.literal(false), personalConnectionRequired: z.literal(false), browserScopeRevision: z.string().min(1).max(256) })
const connection = z.object({ schemaVersion: z.literal(1), controller: z.literal('sleepypod-core'), installationId: reportIdSchema, challenge: z.string() }).strict()

/** Owner browser cookies stay at this origin. The client has no token input or actuator route. */
export function ownerReportWorkspace(fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
  const read = async (path: string, signal: AbortSignal) => {
    const response = await fetcher(path, { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal })
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('Report request failed.')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty report response.')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > 512 * 1024 || signal.aborted) throw new Error('Report response interrupted or too large.')
        chunks.push(next.value)
      }
      if (signal.aborted) throw new Error('Report request interrupted.')
      const output = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)) as unknown
    }
    finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const transport: ReportBrowserTransport = {
    async access(signal) {
      const session = browserSession.parse(await read('/api/auth/session', signal))
      const challenge = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
      const identity = connection.parse(await read(`/api/v1/connection?challenge=${challenge}`, signal))
      if (identity.challenge !== challenge) throw new Error('Connection challenge changed.')
      return { scope: { kind: 'legacy', installationId: identity.installationId }, revision: session.browserScopeRevision }
    },
    read: (id, signal) => read(id === null ? '/api/v1/reports' : `/api/v1/reports/${reportIdSchema.parse(id)}`, signal),
  }
  return new MorningReportBrowserWorkspace(transport)
}
