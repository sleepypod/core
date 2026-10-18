// @vitest-environment node
import { createHash, hkdfSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseTarHeader } from '@/src/biometrics/backtest/bundle-tar'

const state = vi.hoisted(() => ({ archive: '', source: '', seed: { source: 'mmc-cid', value: 'cid-0123' } as { source: string, value: string } }))
vi.mock('@/src/lib/podStorage', () => ({
  get ARCHIVE_DIR() {
    return state.archive
  },
}))
vi.mock('@/src/db', () => ({ biometricsDb: { $client: { get name() {
  return state.source
} } } }))
vi.mock('@/src/homekit/storage', () => ({ readSeed: () => state.seed }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: () => ({ getLastStatus: () => ({ podVersion: 'J00', sensorLabel: '20600-0003-J55-B0708DE3' }) }),
}))

const START = Date.UTC(2026, 9, 10, 6)
const END = Date.UTC(2026, 9, 10, 14)
const MINUTE = 60_000
const journal = JSON.parse(readFileSync(join(process.cwd(), 'src/db/biometrics-migrations/meta/_journal.json'), 'utf-8')) as { entries: Array<{ when: number, tag: string }> }
const latest = journal.entries[journal.entries.length - 1]

let root: string
let snapshots: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'analysis-export-test-'))
  state.archive = join(root, 'biometrics-archive')
  snapshots = join(root, 'tmpfs')
  mkdirSync(state.archive)
  mkdirSync(snapshots)
  vi.stubEnv('TMPDIR', snapshots)
  state.source = join(root, 'biometrics.db')
  const database = new Database(state.source)
  database.pragma('journal_mode = WAL')
  database.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC); CREATE TABLE vitals (id INTEGER PRIMARY KEY, heart_rate REAL)')
  database.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?), (?, ?)').run('old-hash', 1, 'latest-hash', latest.when)
  // Left in the WAL (no checkpoint) so the snapshot must include uncheckpointed pages.
  database.prepare('INSERT INTO vitals (heart_rate) VALUES (?), (?)').run(58, 61)
  sources.push(database)
})
const sources: Database.Database[] = []
afterEach(() => {
  for (const database of sources.splice(0)) database.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function archive(name: string, mtimeMs: number, body: string | Buffer = `frame ${name}`) {
  const path = join(state.archive, name)
  writeFileSync(path, body)
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  return path
}

async function loadRoute() {
  vi.resetModules()
  return await import('./route')
}

const get = (GET: (request: Request) => Promise<Response>, query: string, init?: RequestInit) =>
  GET(new Request(`http://pod/api/biometrics/analysis-export?${query}`, init))

function untar(buffer: Buffer) {
  const entries: Array<{ name: string, body: Buffer }> = []
  let position = 0
  for (;;) {
    const header = parseTarHeader(buffer.subarray(position, position + 512))
    position += 512
    if (!header) break
    entries.push({ name: header.name, body: buffer.subarray(position, position + header.bytes) })
    position += Math.ceil(header.bytes / 512) * 512
  }
  return entries
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('GET /api/biometrics/analysis-export', () => {
  it('selects archives by the widened mtime window and streams a hashed snapshot', async () => {
    archive('A0000001.RAW.gz', START - 21 * MINUTE)
    archive('A0000002.RAW.gz', START - 19 * MINUTE)
    archive('A0000003.RAW.gz', START + 4 * 60 * MINUTE, Buffer.alloc(1300, 7))
    archive('A0000004.RAW.gz', END + 44 * MINUTE)
    archive('A0000005.RAW.gz', END + 46 * MINUTE)
    archive('A0000006.RAW.gz.tmp.4242', START + MINUTE)
    archive('notes.txt', START + MINUTE)
    symlinkSync(archive('linked-target', START), join(state.archive, 'A0000007.RAW.gz'))
    const before = readdirSync(state.archive).sort()

    const { GET } = await loadRoute()
    const response = await get(GET, `start=${new Date(START).toISOString()}&end=${END}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/x-tar')
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform')
    const buffer = Buffer.from(await response.arrayBuffer())
    expect(buffer.length).toBe(Number(response.headers.get('Content-Length')))

    const entries = untar(buffer)
    expect(entries.map(entry => entry.name)).toEqual(['biometrics.db', 'raw/A0000002.RAW.gz', 'raw/A0000003.RAW.gz', 'raw/A0000004.RAW.gz', 'manifest.json'])
    const manifest = JSON.parse(entries[4].body.toString())
    expect(manifest.formatVersion).toBe('analysis-export-v1')
    expect(manifest.files).toEqual(entries.slice(0, 4).map(entry => expect.objectContaining({ path: entry.name, bytes: entry.body.length, sha256: sha256(entry.body) })))
    expect(manifest.files[2]).toEqual({ role: 'raw', path: 'raw/A0000003.RAW.gz', name: 'A0000003.RAW.gz', mtimeMs: START + 4 * 60 * MINUTE, bytes: 1300, sha256: sha256(Buffer.alloc(1300, 7)) })
    expect(manifest.window).toEqual({
      requested: { startMs: START, endMs: END, start: new Date(START).toISOString(), end: new Date(END).toISOString() },
      rawSelection: { includeRaw: true, mtimeFromMs: START - 20 * MINUTE, mtimeToMs: END + 45 * MINUTE },
      served: { archiveCount: 3, rawMtimeMinMs: START - 19 * MINUTE, rawMtimeMaxMs: END + 44 * MINUTE },
    })
    expect(manifest.pod).toEqual({ id: Buffer.from(hkdfSync('sha256', 'cid-0123', 'sleepypod-pod-id-v1', 'pod-id', 16)).toString('hex'),
      idSource: 'mmc-cid', hostname: hostname(), model: { podVersion: 'J00', name: 'Pod 5', hardwareRevision: 'J55' } })
    expect(manifest.schema.biometrics).toEqual({ migrationHash: 'latest-hash', migrationCreatedAt: latest.when, migrationTag: latest.tag, appliedMigrations: 2 })
    expect(manifest.build).toEqual(expect.objectContaining({ branch: expect.any(String), commitHash: expect.any(String) }))

    const extracted = join(root, 'extracted.db')
    writeFileSync(extracted, entries[0].body)
    const copy = new Database(extracted, { readonly: true })
    expect(copy.prepare('SELECT heart_rate FROM vitals ORDER BY id').pluck().all()).toEqual([58, 61])
    copy.close()

    expect(readdirSync(snapshots)).toEqual([])
    expect(readdirSync(state.archive).sort()).toEqual(before)
  })

  it('omits RAW archives with raw=0', async () => {
    archive('A0000001.RAW.gz', START)
    const { GET } = await loadRoute()
    const response = await get(GET, `start=${START}&end=${END}&raw=0`)
    const entries = untar(Buffer.from(await response.arrayBuffer()))
    expect(entries.map(entry => entry.name)).toEqual(['biometrics.db', 'manifest.json'])
    const manifest = JSON.parse(entries[1].body.toString())
    expect(manifest.window.served).toEqual({ archiveCount: 0, rawMtimeMinMs: null, rawMtimeMaxMs: null })
    expect(manifest.window.rawSelection.includeRaw).toBe(false)
  })

  it('reports a null pod id when only a random dev seed exists', async () => {
    state.seed = { source: 'random-dev', value: 'abc' }
    try {
      const { GET } = await loadRoute()
      const entries = untar(Buffer.from(await (await get(GET, `start=${START}&end=${END}`)).arrayBuffer()))
      expect(JSON.parse(String(entries.at(-1)?.body)).pod).toMatchObject({ id: null, idSource: 'random-dev' })
    }
    finally {
      state.seed = { source: 'mmc-cid', value: 'cid-0123' }
    }
  })

  it.each([
    ['', 'missing start and end'],
    [`start=${START}`, 'missing end'],
    [`start=${END}&end=${START}`, 'start after end'],
    [`start=${START}&end=${START}`, 'empty window'],
    [`start=${START}&end=${START + 14 * 24 * 60 * MINUTE + 1}`, 'over 14 days'],
    [`start=yesterday&end=${END}`, 'unparseable start'],
    [`start=${START}&end=${END}&raw=yes`, 'bad raw flag'],
  ])('rejects %s (%s) with 400', async (query) => {
    const { GET } = await loadRoute()
    const response = await get(GET, query)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/start and end/)
    expect(readdirSync(snapshots)).toEqual([])
  })

  it('accepts exactly 14 days', async () => {
    const { GET } = await loadRoute()
    const response = await get(GET, `start=${START}&end=${START + 14 * 24 * 60 * MINUTE}&raw=0`)
    expect(response.status).toBe(200)
    await response.arrayBuffer()
  })

  it('rejects windows over 2 GiB of RAW with 413 and no snapshot', async () => {
    const sparse = archive('A0000001.RAW.gz', START, '')
    truncateSync(sparse, 2 * 1024 ** 3 - 10)
    utimesSync(sparse, START / 1000, START / 1000)
    archive('A0000002.RAW.gz', START + MINUTE, Buffer.alloc(11))
    const { GET } = await loadRoute()
    const response = await get(GET, `start=${START}&end=${END}`)
    expect(response.status).toBe(413)
    expect((await response.json()).error).toMatch(/2 RAW archives totalling 2147483649 bytes.*raw=0/)
    expect(readdirSync(snapshots)).toEqual([])
    const without = await get(GET, `start=${START}&end=${END}&raw=0`)
    expect(without.status).toBe(200)
    await without.arrayBuffer()
  })

  it('allows one export at a time and removes the snapshot when the client cancels', async () => {
    archive('A0000001.RAW.gz', START, Buffer.alloc(600_000, 1))
    const { GET } = await loadRoute()
    const first = await get(GET, `start=${START}&end=${END}`)
    expect(readdirSync(snapshots)).toHaveLength(1)
    expect((await get(GET, `start=${START}&end=${END}`)).status).toBe(429)
    const reader = (first.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await reader.cancel()
    await vi.waitFor(() => expect(readdirSync(snapshots)).toEqual([]))
    const next = await get(GET, `start=${START}&end=${END}&raw=0`)
    expect(next.status).toBe(200)
    await next.arrayBuffer()
  })

  it('removes the snapshot when the request is aborted mid-stream', async () => {
    archive('A0000001.RAW.gz', START, Buffer.alloc(600_000, 1))
    const { GET } = await loadRoute()
    const controller = new AbortController()
    const response = await get(GET, `start=${START}&end=${END}`, { signal: controller.signal })
    await (response.body as ReadableStream<Uint8Array>).getReader().read()
    controller.abort()
    await vi.waitFor(() => expect(readdirSync(snapshots)).toEqual([]))
    expect((await get(GET, `start=${START}&end=${END}&raw=0`)).status).toBe(200)
  })

  it('cleans up and streams nothing when the client left while the snapshot was taken', async () => {
    archive('A0000001.RAW.gz', START)
    const { GET } = await loadRoute()
    const controller = new AbortController()
    controller.abort()
    const response = await get(GET, `start=${START}&end=${END}`, { signal: controller.signal })
    expect(response.status).toBe(499)
    expect(readdirSync(snapshots)).toEqual([])
    expect((await get(GET, `start=${START}&end=${END}&raw=0`)).status).toBe(200)
  })

  it('aborts the stream and removes the snapshot when an archive vanishes', async () => {
    const path = archive('A0000001.RAW.gz', START)
    const { GET } = await loadRoute()
    const response = await get(GET, `start=${START}&end=${END}`)
    unlinkSync(path)
    await expect(response.arrayBuffer()).rejects.toThrow()
    await vi.waitFor(() => expect(readdirSync(snapshots)).toEqual([]))
  })

  it('returns 500 and cleans up when the database cannot be read', async () => {
    state.source = join(root, 'missing.db')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { GET } = await loadRoute()
    const response = await get(GET, `start=${START}&end=${END}`)
    expect(response.status).toBe(500)
    expect(error).toHaveBeenCalled()
    expect(readdirSync(snapshots)).toEqual([])
    error.mockRestore()
  })
})
