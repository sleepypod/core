// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { POST } from './route'

let directory: string
let server: Server
const seen = new Set<string>()
const requests: Array<{ side: string, source: string, metric?: string, samples?: Array<{ value?: number, heartRate?: number }> }> = []
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'watch-upload-test-'))
  vi.stubEnv('WATCH_UPLOAD_DIR', directory)
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const data = JSON.parse(body)
    requests.push(data)
    let written = 0
    for (const sample of data.samples ?? []) {
      const key = `${data.metric ?? 'heart_rate'}:${sample.timestamp}`
      if (!seen.has(key)) {
        seen.add(key)
        written++
      }
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ written }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  vi.stubEnv('PORT', String(address.port))
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

it('streams XML through the real importer, routes to the selected side, dedupes, and removes the file', async () => {
  const date = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000')
  const xml = `<HealthData><Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" startDate="${date}" endDate="${date}" value="62" unit="count/min" /></HealthData>`
  const request = () => new Request('http://pod/api/biometrics/watch-upload?side=right&days=7', { method: 'POST', body: xml })
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ vitals: 1, stages: 0, matchedVitals: 1 })
  expect(requests[0]).toMatchObject({ side: 'right', source: 'apple_watch' })
  expect(await (await POST(request())).json()).toMatchObject({ vitals: 0, matchedVitals: 1 })
  expect(await readdir(directory)).toEqual([])
})

it('imports Watch breathing rate and HRV, skips records sleepypod wrote to Health, and dedupes per metric', async () => {
  requests.length = 0
  const date = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000')
  const record = (type: string, source: string, value: number, unit: string) =>
    `<Record type="HKQuantityTypeIdentifier${type}" sourceName="${source}" startDate="${date}" endDate="${date}" value="${value}" unit="${unit}" />`
  const xml = `<HealthData>${[
    record('RespiratoryRate', 'Apple Watch', 14.5, 'count/min'),
    record('HeartRateVariabilitySDNN', 'Apple Watch', 48, 'ms'),
    // The pod's own readings written back by the iOS app, even from a source named like a Watch.
    record('RespiratoryRate', 'sleepypod', 99, 'count/min'),
    record('HeartRateVariabilitySDNN', 'sleepypod design', 99, 'ms'),
    record('HeartRate', 'sleepypod Watch', 99, 'count/min'),
  ].join('')}</HealthData>`
  const request = () => new Request('http://pod/api/biometrics/watch-upload?side=left&days=7', { method: 'POST', body: xml })
  expect(await (await POST(request())).json()).toEqual({ stages: 0, vitals: 0, breathing: 1, hrv: 1, rejectedStageBatches: 0,
    matchedStages: 0, matchedVitals: 0, matchedBreathing: 1, matchedHrv: 1 })
  expect(requests.map(r => [r.metric, r.side, r.samples?.map(s => s.value)])).toEqual([['breathing_rate', 'left', [14.5]], ['hrv_sdnn', 'left', [48]]])
  expect(await (await POST(request())).json()).toMatchObject({ breathing: 0, hrv: 0, matchedBreathing: 1, matchedHrv: 1 })
})

it('rejects malformed files and cleans up after parser failure', async () => {
  const response = await POST(new Request('http://pod/api/biometrics/watch-upload?side=left', { method: 'POST', body: '<HealthData><broken' }))
  expect(response.status).toBe(422)
  expect(await readdir(directory)).toEqual([])
})

it('gives import a fresh budget after staging and ignores the expired upload budget', async () => {
  const upload = new AbortController()
  const importer = new AbortController()
  let staged = false
  const timeout = vi.spyOn(AbortSignal, 'timeout')
    .mockReturnValueOnce(upload.signal)
    .mockImplementationOnce(() => {
      expect(staged).toBe(true)
      upload.abort(new DOMException('Upload budget expired', 'TimeoutError'))
      return importer.signal
    })
  try {
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('<HealthData/>'))
        staged = true
        controller.close()
      },
    })
    const request = new Request('http://pod/api/biometrics/watch-upload?side=left', { method: 'POST', body, duplex: 'half' } as RequestInit)
    const response = await POST(request)
    expect(response.status).toBe(200)
    expect(timeout.mock.calls.map(call => call[0])).toEqual([30 * 60_000, 10 * 60_000])
    expect(await readdir(directory)).toEqual([])
  }
  finally { timeout.mockRestore() }
})

it('accepts a same-origin browser upload even though Next reports the 0.0.0.0 bind address in request.url', async () => {
  const response = await POST(new Request('http://0.0.0.0:3000/api/biometrics/watch-upload?side=left', {
    method: 'POST', headers: { origin: 'http://192.168.1.88:3000', host: '192.168.1.88:3000' }, body: '<HealthData/>',
  }))
  expect(response.status).toBe(200)
  expect(await readdir(directory)).toEqual([])
})

it('rejects a DNS-rebinding Host itself, since proxy.ts skips this route', async () => {
  const response = await POST(new Request('http://0.0.0.0:3000/api/biometrics/watch-upload?side=left', {
    method: 'POST', headers: { origin: 'http://attacker.example.com:3000', host: 'attacker.example.com:3000' }, body: '<HealthData/>',
  }))
  expect(response.status).toBe(403)
  expect(await readdir(directory)).toEqual([])
})

it('reports a body cut short of its Content-Length instead of a generic import failure', async () => {
  const before = requests.length
  const zip = new Uint8Array(4096).fill(0x41)
  zip.set([0x50, 0x4B, 0x03, 0x04])
  const response = await POST(new Request('http://pod/api/biometrics/watch-upload?side=left', {
    method: 'POST', headers: { 'content-length': String(zip.byteLength * 2) }, body: zip,
  }))
  expect(response.status).toBe(400)
  expect((await response.json()).error).toBe('Upload incomplete: the pod received 4096 of 8192 bytes. Nothing was imported; retry the upload.')
  expect(requests.length).toBe(before)
  expect(await readdir(directory)).toEqual([])
})

it('rejects cross-origin requests, missing side, and oversized bodies before import', async () => {
  for (const origin of ['http://evil', 'http://192.168.1.88:8080', 'null']) {
    const response = await POST(new Request('http://0.0.0.0:3000/api/biometrics/watch-upload?side=left', { method: 'POST', headers: { origin, host: '192.168.1.88:3000' }, body: 'x' }))
    expect(response.status).toBe(403)
  }
  expect((await POST(new Request('http://pod/api/biometrics/watch-upload', { method: 'POST', body: 'x' }))).status).toBe(400)
  expect((await POST(new Request('http://pod/api/biometrics/watch-upload?side=left', { method: 'POST', headers: { 'content-length': String(513 * 1024 * 1024) }, body: 'x' }))).status).toBe(413)
})

it('still honors a client disconnect when switching to the import budget', async () => {
  const client = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout')
    .mockReturnValueOnce(new AbortController().signal)
    .mockImplementationOnce(() => {
      client.abort()
      return new AbortController().signal
    })
  try {
    const response = await POST(new Request('http://pod/api/biometrics/watch-upload?side=left', {
      method: 'POST', body: '<HealthData/>', signal: client.signal,
    }))
    expect(response.status).toBe(408)
    expect(await readdir(directory)).toEqual([])
  }
  finally { timeout.mockRestore() }
})

it('rejects missing and empty bodies without retaining staged files', async () => {
  for (const body of [undefined, '']) {
    const response = await POST(new Request('http://pod/api/biometrics/watch-upload?side=left', { method: 'POST', body }))
    expect(response.status).toBe(400)
    expect(await readdir(directory)).toEqual([])
  }
})

it('enforces the streaming size limit even without a content-length header', async () => {
  const chunk = new Uint8Array(1)
  Object.defineProperty(chunk, 'byteLength', { value: 513 * 1024 * 1024 })
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
  const response = await POST(new Request('http://pod/api/biometrics/watch-upload?side=left', { method: 'POST', body, duplex: 'half' } as RequestInit))
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ error: 'Upload exceeds 512 MiB' })
  expect(await readdir(directory)).toEqual([])
})

it('rejects concurrent uploads and releases the slot after staging is cancelled', async () => {
  const client = new AbortController()
  const response = POST(new Request('http://pod/api/biometrics/watch-upload?side=left', {
    method: 'POST', body: new ReadableStream(), duplex: 'half', signal: client.signal,
  } as RequestInit))
  const competing = await POST(new Request('http://pod/api/biometrics/watch-upload?side=right', { method: 'POST', body: '<HealthData/>' }))
  expect(competing.status).toBe(409)
  client.abort()
  expect((await response).status).toBe(408)
  expect(await readdir(directory)).toEqual([])
  expect((await POST(new Request('http://pod/api/biometrics/watch-upload?side=left', { method: 'POST', body: '<HealthData/>' }))).status).toBe(200)
})
