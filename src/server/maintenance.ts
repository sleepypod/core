import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { z } from 'zod'

const brokerReply = z.object({
  requestId: z.string(),
  outcome: z.enum(['accepted', 'rejected', 'unknown']),
  message: z.string().min(1).max(1024),
}).strict()

const UNKNOWN_OUTCOME = 'Maintenance could not be confirmed. Reconnect and inspect service health.'

/** A configured broker is the only transport: failures never fall back to sudo or the updater. */
export async function requestBrokerRestart(unit: string, socketPath: string) {
  const invocationId = process.env.INVOCATION_ID
  if (!invocationId || !/^[a-f0-9]{32}$/.test(invocationId) || !socketPath.startsWith('/') || socketPath.includes('\0')) {
    return { ok: false, message: 'Maintenance is unavailable outside the configured Core service invocation.' }
  }
  const issuedAt = Date.now()
  const request = { version: 1, requestId: randomUUID(), invocationId, unit, issuedAt, expiresAt: issuedAt + 5000 }
  return new Promise<{ ok: boolean, message: string }>((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    let buffer = Buffer.alloc(0)
    let finished = false
    // Bound the complete operation, not only idle socket time between chunks.
    const timer = setTimeout(() => finish(new Error(UNKNOWN_OUTCOME)), 8000)
    function finish(error: Error | null, result?: { ok: boolean, message: string }) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error(UNKNOWN_OUTCOME))
    }
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 4096) return finish(new Error(UNKNOWN_OUTCOME))
      if (!buffer.includes(10)) return
      try {
        const text = buffer.toString('utf8')
        if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw new Error('Invalid reply frame')
        const reply = brokerReply.parse(JSON.parse(text))
        if (reply.requestId !== request.requestId || reply.outcome === 'unknown') throw new Error(UNKNOWN_OUTCOME)
        finish(null, { ok: reply.outcome === 'accepted', message: reply.message })
      }
      catch {
        finish(new Error(UNKNOWN_OUTCOME))
      }
    })
    socket.once('error', () => finish(new Error(UNKNOWN_OUTCOME)))
    socket.once('close', () => {
      if (!finished) finish(new Error(UNKNOWN_OUTCOME))
    })
  })
}
