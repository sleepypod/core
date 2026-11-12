import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { readReportBody, reportResponse, type ReportAccess } from '../http'
import { MorningReportStore } from '../store'
import { appendAnswer, legacyReportScope, reportFixture, reportNow } from './fixture'

let database: Database.Database, store: MorningReportStore, access: ReportAccess
const request = (suffix = '', method = 'GET', signal?: AbortSignal) => new Request(`https://pod.test/api/v1/reports${suffix}`, { method, signal })
beforeEach(() => {
  database = migratedComfortDatabase()
  store = new MorningReportStore(database, () => reportNow)
  const identity = legacyReportScope()
  access = { identity, scope: identity }
})
afterEach(() => database.close())
const serve = (input: Request, body?: unknown) => reportResponse(input, body, store, () => access, () => reportNow)

describe('report HTTP snapshots', () => {
  it('returns a private list and full dated report, with a fresh conditional revision', async () => {
    const input = reportFixture()
    const saved = serve(request(`/${input.report.id}`, 'PUT'), { expectedRevision: null, document: input })
    expect(saved.headers.get('cache-control')).toBe('private, no-store')
    expect(saved.headers.get('vary')).toContain('Authorization')
    const result = await saved.json()
    expect(result.scope).toEqual(access.scope)
    expect(result.report).toEqual(input.report)
    expect(result.generatedAt).toBe(reportNow)
    const listed = await serve(request()).json()
    expect(listed.reports).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(input.report.text)
    expect(await serve(request(`/${input.report.id}`, 'HEAD')).text()).toBe('')
  })

  it('does not repeat mutations when the response body is read', async () => {
    const input = reportFixture(), saved = serve(request(`/${input.report.id}`, 'PUT'), { expectedRevision: null, document: input })
    const original = store.read(access.identity, input.report.id).receipt
    expect((await saved.json()).receipt).toEqual(original)
    expect(store.read(access.identity, input.report.id).receipt).toEqual(original)
    const removed = serve(request(`/${input.report.id}`, 'DELETE'), { expectedRevision: original.revision })
    const tombstone = store.read(access.identity, input.report.id).receipt
    expect((await removed.json()).receipt).toEqual(tombstone)
    expect(store.read(access.identity, input.report.id).receipt).toEqual(tombstone)
  })

  it.each(['account', 'revision', 'updated', 'deleted', 'aborted'])('withdraws a queued private response after %s changes', async (kind) => {
    const input = reportFixture(), saved = store.save(access.identity, input.report.id, input, null)
    const abort = new AbortController(), pending = serve(request(`/${input.report.id}`, 'GET', abort.signal))
    if (kind === 'account') access = { identity: legacyReportScope(), scope: { changed: true } }
    if (kind === 'revision') access = { ...access, scope: { ...access.scope, sessionRevision: 2 } }
    if (kind === 'updated') store.save(access.identity, input.report.id, appendAnswer(input), saved.revision)
    if (kind === 'deleted') store.remove(access.identity, input.report.id, saved.revision)
    if (kind === 'aborted') abort.abort()
    await expect(pending.text()).rejects.toThrow('changed before delivery')
  })

  it('does not save on an aborted request or accept client-supplied account selectors', () => {
    const input = reportFixture(), body = { expectedRevision: null, document: input }
    expect(() => serve(request(`/${input.report.id}`, 'PUT', AbortSignal.abort()), body)).toThrow('interrupted')
    expect(() => serve(request(`/${input.report.id}?accountId=${randomUUID()}`, 'PUT'), body)).toThrow('without query')
    expect(() => serve(request(`/${input.report.id}`, 'PUT'), { ...body, accountId: randomUUID() })).toThrow()
    expect(store.list(access.identity)).toEqual([])
  })

  it('refuses unsupported methods and destination IDs', () => {
    for (const input of [request('', 'PUT'), request('', 'DELETE'), request('', 'POST'), request('/not-an-id')])
      expect(() => serve(input, {})).toThrow()
  })
})

describe('bounded streamed report upload', () => {
  const upload = (body: BodyInit, headers = { 'content-type': 'application/json' }) => new Request('https://pod.test/api/v1/reports', {
    method: 'PUT', headers, body, duplex: 'half',
  } as RequestInit)
  it('reads a valid request spanning multiple chunks and never trusts Content-Length', async () => {
    const input = reportFixture(), text = JSON.stringify({ expectedRevision: null, document: input }), bytes = new TextEncoder().encode(text)
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 20))
      controller.enqueue(bytes.slice(20))
      controller.close()
    } })
    expect(await readReportBody(upload(stream))).toEqual(JSON.parse(text))
  })
  it('rejects oversized, malformed, non-UTF8 and wrong-content-type requests', async () => {
    await expect(readReportBody(upload('x'.repeat(400 * 1024 + 1)))).rejects.toMatchObject({ status: 413 })
    await expect(readReportBody(upload('{'))).rejects.toMatchObject({ status: 400 })
    await expect(readReportBody(upload(new Uint8Array([0xff])))).rejects.toMatchObject({ status: 400 })
    await expect(readReportBody(upload('{}', { 'content-type': 'text/plain' }))).rejects.toMatchObject({ status: 415 })
  })

  it('ends an interrupted upload even when the sender never supplies another chunk', async () => {
    const abort = new AbortController()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
      cancel() { cancelled = true } })
    const pending = readReportBody(new Request(upload(stream), { signal: abort.signal }))
    abort.abort()
    await expect(pending).rejects.toMatchObject({ status: 408 })
    expect(cancelled).toBe(true)
  })
})
