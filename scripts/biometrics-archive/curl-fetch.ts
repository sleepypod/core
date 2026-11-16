import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'

const HEADER_END = Buffer.from('\r\n\r\n')

function parseHead(head: string) {
  // curl -i prints every response head; a 100 Continue head precedes the real one.
  const blocks = head.split('\r\n\r\n').filter(Boolean)
  const lines = (blocks.at(-1) ?? '').split('\r\n')
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? '')?.[1])
  if (!Number.isInteger(status)) throw new TypeError('fetch failed', { cause: new Error(`curl returned no HTTP status line: ${lines[0] ?? ''}`) })
  const headers = new Headers()
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return { status, headers }
}

/**
 * GET over /usr/bin/curl, for what `pull` needs: status, headers and a streamed body.
 * macOS Local Network privacy refuses LAN connections from node (EHOSTUNREACH) when
 * the process lacks the permission, as in launchd agents; Apple's own binaries are exempt.
 */
export function curlFetch(curlPath = '/usr/bin/curl'): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if ((init?.method ?? 'GET') !== 'GET') throw new TypeError('curlFetch supports GET only')
    const child = spawn(curlPath, ['-sS', '-i', '--no-buffer', '--', url], { stdio: ['ignore', 'pipe', 'pipe'], signal: init?.signal ?? undefined })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', resolve)
      child.on('error', () => resolve(null))
    })
    const failure = () => new Error(stderr.trim() || 'curl exited before the response finished')
    return new Promise<Response>((resolve, reject) => {
      let head = Buffer.alloc(0), headed = false
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        // Skip interim heads (100 Continue) until a final one ends.
        for (let at = head.indexOf(HEADER_END); at >= 0; at = head.indexOf(HEADER_END, at + 4)) {
          if (/^HTTP\/[\d.]+ 1\d\d/.test(head.subarray(head.lastIndexOf('HTTP/', at), at).toString('latin1'))) continue
          headed = true
          child.stdout.off('data', onData)
          child.stdout.pause()
          let parsed
          try {
            parsed = parseHead(head.subarray(0, at + 4).toString('latin1'))
          }
          catch (error) {
            child.kill()
            reject(error)
            return
          }
          const rest = head.subarray(at + 4)
          const body = Readable.from((async function* () {
            if (rest.length) yield rest
            for await (const piece of child.stdout) yield piece as Buffer
            if (await exited !== 0) throw failure()
          })())
          resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, parsed))
          return
        }
      }
      child.stdout.on('data', onData)
      void exited.then(() => {
        if (!headed) reject(new TypeError('fetch failed', { cause: failure() }))
      })
    })
  }) as typeof fetch
}
