// @vitest-environment node
import { createHash } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as unknown, raw: null as { exec: (sql: string) => void } | null }))
vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
  const schema = await import('@/src/db/biometrics-schema')
  const raw = new Database(':memory:')
  const db = drizzle(raw, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  state.db = db
  state.raw = raw
  return { biometricsDb: db }
})

const { POST, GET } = await import('./route')
const { GET: GET_ONE } = await import('./[id]/route')

const FROM = 1_793_618_344_598
const TO = FROM + 8 * 3600_000
const FIRST_BIN = Math.floor(FROM / 2000) * 2000 // overlaps the start edge, so it is kept

function file(version: 'watch-motion-v1' | 'watch-motion-v2', starts: number[], extra: Record<string, unknown> = {}) {
  const axes = version === 'watch-motion-v2' ? { meanX: starts.map(() => 0.1), meanY: starts.map(() => -0.2), meanZ: starts.map(() => 0.97) } : {}
  return {
    version, recordedFromMs: FROM, recordedToMs: TO, timeZone: 'America/Los_Angeles', utcOffsetSeconds: -28800,
    sampleRateHz: 50, binSeconds: 2, jerkThresholdGPerSecond: 1, device: 'Apple Watch · watchOS 26.6',
    bins: { startMs: starts, samples: starts.map(() => 100), meanMagnitude: starts.map(() => 1), magnitudeVariance: starts.map((_, i) => i * 1e-6),
      maxJerk: starts.map((_, i) => i % 7), movingSamples: starts.map((_, i) => i % 3), ...axes },
    ...extra,
  }
}
const night = Array.from({ length: 90 }, (_, i) => FIRST_BIN + i * 2000)
/** The same file with a bin prepended to every column, as the Watch recorder's leftovers. */
function withStray(f: ReturnType<typeof file>, startMs: number) {
  return { ...f, bins: Object.fromEntries(Object.entries(f.bins).map(([column, values]) => [column, [column === 'startMs' ? startMs : 1, ...values]])) }
}

const post = (body: unknown, side = 'left', headers: Record<string, string> = {}) => POST(new Request(`http://pod/api/biometrics/watch-motion?side=${side}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}))

beforeEach(() => state.raw?.exec('DELETE FROM watch_motion_captures'))

it('accepts a v1 file and serves the stored canonical file back byte-for-byte', async () => {
  const response = await post(file('watch-motion-v1', night))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toEqual({ id: expect.any(Number), side: 'left', version: 'watch-motion-v1', recordedFromMs: FROM, recordedToMs: TO, bins: 90, trimmedBins: 0, status: 'created' })
  const stored = await GET_ONE(new Request('http://pod'), { params: Promise.resolve({ id: String(body.id) }) })
  expect(stored.headers.get('content-type')).toBe('application/json')
  const text = await stored.text()
  expect(JSON.parse(text)).toEqual(file('watch-motion-v1', night))
  // Keys sorted at every level, like the iOS encoder.
  expect(text.indexOf('"binSeconds"')).toBeLessThan(text.indexOf('"bins"'))
  expect(text.indexOf('"magnitudeVariance"')).toBeLessThan(text.indexOf('"startMs"'))
  const [listed] = await (await GET(new Request('http://pod/api/biometrics/watch-motion?side=left'))).json()
  expect(listed).toMatchObject({ id: body.id, sha256: createHash('sha256').update(text).digest('hex'), bins: 90, trimmedBins: 0 })
})

it('accepts a v2 file with axis means', async () => {
  const response = await post(file('watch-motion-v2', night), 'right')
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toMatchObject({ side: 'right', version: 'watch-motion-v2', bins: 90, status: 'created' })
  const stored = JSON.parse(await (await GET_ONE(new Request('http://pod'), { params: Promise.resolve({ id: String(body.id) }) })).text())
  expect(stored.bins.meanZ).toHaveLength(90)
})

it('trims a stray bin from an earlier recording and counts it', async () => {
  const stray = FROM - 20 * 3600_000 - (FROM - 20 * 3600_000) % 2000
  const after = Math.ceil(TO / 2000) * 2000
  const response = await post(file('watch-motion-v2', [stray, stray + 2000, ...night, after]))
  expect(await response.json()).toMatchObject({ bins: 90, trimmedBins: 3, status: 'created' })
  const [listed] = await (await GET(new Request(`http://pod/api/biometrics/watch-motion?startDate=${FROM}&endDate=${new Date(TO).toISOString()}`))).json()
  expect(listed).toMatchObject({ bins: 90, trimmedBins: 3, recordedFromMs: FROM })
  const stored = JSON.parse(await (await GET_ONE(new Request('http://pod'), { params: Promise.resolve({ id: String(listed.id) }) })).text())
  expect(stored.bins.startMs[0]).toBe(FIRST_BIN)
  expect(stored.bins.meanX).toHaveLength(90)
  // Each kept bin keeps its own values.
  expect(stored.bins.maxJerk).toEqual(night.map((_, i) => (i + 2) % 7))
})

it('reports unchanged for identical content and replaced for new content of the same night', async () => {
  const first = await (await post(file('watch-motion-v1', night))).json()
  // A fixed app resending without the stray bin stores the same trimmed file.
  const again = await (await post(withStray(file('watch-motion-v1', night), FIRST_BIN - 40 * 3600_000))).json()
  expect(again).toMatchObject({ id: first.id, status: 'unchanged', trimmedBins: 1 })
  const replaced = await (await post(file('watch-motion-v2', night))).json()
  expect(replaced).toMatchObject({ id: first.id, status: 'replaced', version: 'watch-motion-v2' })
  expect(await (await GET(new Request('http://pod/api/biometrics/watch-motion'))).json()).toHaveLength(1)
  // The other side is a separate capture.
  expect(await (await post(file('watch-motion-v1', night), 'right')).json()).toMatchObject({ status: 'created' })
})

it('rejects raw readings, oversize bodies and invalid files', async () => {
  const rawResponse = await post(file('watch-motion-v1', night, { raw: [[FROM, 0, 0, 1]] }))
  expect(rawResponse.status).toBe(400)
  expect(await rawResponse.json()).toEqual({ error: 'raw readings are not accepted' })

  expect((await post('x', 'left', { 'content-length': String(8 * 1024 * 1024 + 1) })).status).toBe(413)
  const chunk = new Uint8Array(1)
  Object.defineProperty(chunk, 'byteLength', { value: 8 * 1024 * 1024 + 1 })
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(chunk)
    controller.close()
  } })
  const streamed = await POST(new Request('http://pod/api/biometrics/watch-motion?side=left', { method: 'POST', body: stream, duplex: 'half' } as RequestInit))
  expect(streamed.status).toBe(413)

  const mismatched = file('watch-motion-v1', night)
  mismatched.bins.maxJerk.pop()
  const cases: Array<[unknown, RegExp]> = [
    [mismatched, /bins\.maxJerk differ/],
    [file('watch-motion-v1', night, { version: 'watch-motion-v3' }), /version/],
    [file('watch-motion-v1', night, { binSeconds: 1 }), /binSeconds/],
    [file('watch-motion-v2', night, { bins: { ...file('watch-motion-v1', night).bins } }), /v2 requires/],
    [file('watch-motion-v1', night, { bins: file('watch-motion-v2', night).bins }), /v1 must not/],
    [file('watch-motion-v1', [FIRST_BIN, FIRST_BIN + 1000]), /multiple of 2000/],
    [file('watch-motion-v1', [FIRST_BIN + 2000, FIRST_BIN]), /strictly increasing/],
    [file('watch-motion-v1', [FIRST_BIN, FIRST_BIN + 2000], { bins: { ...file('watch-motion-v1', [FIRST_BIN, FIRST_BIN + 2000]).bins, movingSamples: [1, -1] } }), /movingSamples/],
    [file('watch-motion-v1', [FIRST_BIN, FIRST_BIN + 2000], { bins: { ...file('watch-motion-v1', [FIRST_BIN, FIRST_BIN + 2000]).bins, samples: [1.5, 2] } }), /samples/],
    [file('watch-motion-v1', [FIRST_BIN - 3600_000]), /No bins fall inside/],
    [file('watch-motion-v1', night, { recordedToMs: FROM }), /recordedToMs must be after/],
    [file('watch-motion-v1', night, { extra: 1 }), /extra/],
  ]
  for (const [body, message] of cases) {
    const response = await post(body)
    expect(response.status, String(message)).toBe(400)
    expect((await response.json()).error).toMatch(message)
  }
  // JSON.parse turns 1e999 into Infinity.
  const infinite = JSON.stringify(file('watch-motion-v1', [FIRST_BIN])).replace('"maxJerk":[0]', '"maxJerk":[1e999]')
  expect((await post(infinite)).status).toBe(400)
  expect((await post('{not json')).status).toBe(400)
  expect((await post('')).status).toBe(400)
  expect((await POST(new Request('http://pod/api/biometrics/watch-motion', { method: 'POST', body: '{}' }))).status).toBe(400)
  expect(await (await GET(new Request('http://pod/api/biometrics/watch-motion'))).json()).toEqual([])
})

it('rejects cross-origin and DNS-rebinding uploads but accepts the same-origin web app', async () => {
  for (const origin of ['http://evil', 'http://192.168.1.88:8080', 'null']) {
    const response = await post(file('watch-motion-v1', night), 'left', { origin, host: '192.168.1.88:3000' })
    expect(response.status).toBe(403)
  }
  const rebound = await post(file('watch-motion-v1', night), 'left', { origin: 'http://attacker.example.com:3000', host: 'attacker.example.com:3000' })
  expect(rebound.status).toBe(403)
  expect(await (await GET(new Request('http://pod/api/biometrics/watch-motion'))).json()).toEqual([])
  const same = await post(file('watch-motion-v1', night), 'left', { origin: 'http://192.168.1.88:3000', host: '192.168.1.88:3000' })
  expect(same.status).toBe(200)
})

it('lists by overlap and validates list and fetch parameters', async () => {
  await post(file('watch-motion-v1', night))
  const list = (query: string) => GET(new Request(`http://pod/api/biometrics/watch-motion?${query}`))
  expect(await (await list(`startDate=${TO}`)).json()).toEqual([])
  expect(await (await list(`endDate=${FROM - 1}`)).json()).toEqual([])
  expect(await (await list(`startDate=${TO - 1}&endDate=${TO + 1}&side=left`)).json()).toHaveLength(1)
  expect(await (await list('side=right')).json()).toEqual([])
  expect((await list('side=middle')).status).toBe(400)
  expect((await list('startDate=yesterday')).status).toBe(400)
  expect((await list(`startDate=${TO}&endDate=${FROM}`)).status).toBe(400)
  expect((await GET_ONE(new Request('http://pod'), { params: Promise.resolve({ id: '999' }) })).status).toBe(404)
  expect((await GET_ONE(new Request('http://pod'), { params: Promise.resolve({ id: '../x' }) })).status).toBe(400)
})
