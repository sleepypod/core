// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataHash } from '../../algorithms/canonical'
import { parseTarHeader } from '../bundle-tar'
import { DatasetStore } from '../datasets'
import { datasetBundleChunks, datasetBundleTarBytes, prepareDatasetExport } from '../dataset-export'
import { exportableWaveformDataset } from './fixtures/export'

const state = vi.hoisted(() => ({ db: undefined as unknown, failure: null as Error | null }))
vi.mock('@/src/db', () => ({
  get biometricsDb() {
    return state.db
  },
}))
vi.mock('@/src/biometrics/backtest/coordinator-service', () => ({
  coordinatorRequest: (db: Parameters<typeof prepareDatasetExport>[0], task: { type: string, input: { id: string } }) => {
    if (task.type !== 'exportDataset') throw new Error('unexpected task')
    if (state.failure) return Promise.reject(state.failure)
    return prepareDatasetExport(db, task.input.id)
  },
}))

let directory: string
let fixture: ReturnType<typeof exportableWaveformDataset>
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dataset-export-'))
  fixture = exportableWaveformDataset(directory)
  state.db = fixture.db
})
afterEach(() => {
  state.failure = null
  fixture.sqlite.close()
  rmSync(directory, { recursive: true, force: true })
})

/** Split a tar buffer into its entries using the shared header parser. */
function untar(buffer: Buffer) {
  const entries = new Map<string, Buffer>()
  let position = 0
  for (;;) {
    const header = parseTarHeader(buffer.subarray(position, position + 512))
    position += 512
    if (!header) break
    entries.set(header.name, buffer.subarray(position, position + header.bytes))
    position += Math.ceil(header.bytes / 512) * 512
  }
  return entries
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function tamper(name: string) {
  const path = join(fixture.rawDirectory, name)
  const bytes = readFileSync(path)
  bytes[bytes.length - 1] ^= 0xff
  writeFileSync(path, bytes)
}

describe('prepareDatasetExport', () => {
  it('lists the manifest, snapshot and exactly the referenced archives with their SHA-256', async () => {
    const { index, manifestText, snapshotText } = await prepareDatasetExport(fixture.db, fixture.id)
    expect(index.dataset).toMatchObject({ id: fixture.id, side: 'left', contentHash: fixture.contentHash, snapshotVersion: 'waveform-dataset-v1' })
    expect(index.files.map(file => file.path)).toEqual(['manifest.json', 'snapshot.json', ...fixture.artifacts.map(artifact => `raw/${artifact.name}`)])
    expect(index.files.some(file => file.path.includes(fixture.unrelated.sha256))).toBe(false)
    expect(index.files[0]).toMatchObject({ sha256: sha256(Buffer.from(manifestText)), bytes: Buffer.byteLength(manifestText) })
    expect(index.files[1]).toMatchObject({ sha256: sha256(Buffer.from(snapshotText)), bytes: Buffer.byteLength(snapshotText) })
    expect(dataHash({ manifest: JSON.parse(manifestText), snapshot: JSON.parse(snapshotText) })).toBe(fixture.contentHash)
    for (const artifact of fixture.artifacts) {
      expect(index.files).toContainEqual({ role: 'raw', path: `raw/${artifact.name}`, sha256: artifact.sha256, bytes: artifact.compressed_bytes, expandedBytes: artifact.expanded_bytes })
    }
  })

  it('treats a released dataset as not found', async () => {
    new DatasetStore(fixture.db).release(fixture.id)
    await expect(prepareDatasetExport(fixture.db, fixture.id)).rejects.toMatchObject({ code: 'DATASET_RELEASED' })
    await expect(prepareDatasetExport(fixture.db, '99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses to export an archive whose bytes no longer match its hash', async () => {
    tamper(fixture.artifacts[1].name)
    await expect(prepareDatasetExport(fixture.db, fixture.id)).rejects.toMatchObject({ code: 'DATASET_CORRUPT', message: expect.stringContaining('SHA-256') })
  })

  it('refuses missing archives and references that disagree with the frozen snapshot', async () => {
    rmSync(join(fixture.rawDirectory, fixture.artifacts[0].name))
    await expect(prepareDatasetExport(fixture.db, fixture.id)).rejects.toMatchObject({ code: 'DATASET_CORRUPT' })
    fixture.sqlite.prepare('UPDATE biometric_dataset_raw_artifacts SET released_at_ms = 1 WHERE artifact_hash = ?').run(fixture.artifacts[0].sha256)
    await expect(prepareDatasetExport(fixture.db, fixture.id)).rejects.toMatchObject({ code: 'DATASET_CORRUPT', message: expect.stringContaining('do not match') })
  })

  it('streams a tar whose size matches the declared length and aborts if an archive changes mid-export', async () => {
    const prepared = await prepareDatasetExport(fixture.db, fixture.id)
    const chunks: Buffer[] = []
    for await (const chunk of datasetBundleChunks(prepared.index, { manifest: prepared.manifestText, snapshot: prepared.snapshotText }, fixture.rawDirectory)) chunks.push(chunk)
    const tar = Buffer.concat(chunks)
    expect(tar.length).toBe(datasetBundleTarBytes(prepared.index))
    const entries = untar(tar)
    expect([...entries.keys()]).toEqual(['bundle.json', ...prepared.index.files.map(file => file.path)])
    for (const file of prepared.index.files) expect(sha256(entries.get(file.path) as Buffer)).toBe(file.sha256)

    tamper(fixture.artifacts[2].name)
    const consume = async () => {
      const chunks = datasetBundleChunks(prepared.index, { manifest: prepared.manifestText, snapshot: prepared.snapshotText }, fixture.rawDirectory)
      while (!(await chunks.next()).done) { /* drain */ }
    }
    await expect(consume()).rejects.toThrow('changed during export')
  })
})

describe('GET /api/biometric-tuning/datasets/{id}/export', () => {
  const get = async (id: string) => {
    const { GET } = await import('@/app/api/biometric-tuning/datasets/[id]/export/route')
    return GET(new Request(`http://pod/api/biometric-tuning/datasets/${id}/export`), { params: Promise.resolve({ id }) })
  }

  it('streams the verified bundle as an attachment', async () => {
    const response = await get(fixture.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/x-tar')
    expect(response.headers.get('x-dataset-content-hash')).toBe(fixture.contentHash)
    const tar = Buffer.from(await response.arrayBuffer())
    expect(tar.length).toBe(Number(response.headers.get('content-length')))
    const index = JSON.parse((untar(tar).get('bundle.json') as Buffer).toString('utf8'))
    expect(index.version).toBe('calibration-dataset-bundle-v1')
    expect(untar(tar).size).toBe(1 + 2 + fixture.artifacts.length)
  })

  it('returns 404 for a released or unknown dataset and 400 for a malformed id', async () => {
    new DatasetStore(fixture.db).release(fixture.id)
    expect((await get(fixture.id)).status).toBe(404)
    expect((await get('99999999-9999-4999-8999-999999999999')).status).toBe(404)
    expect((await get('not-a-uuid')).status).toBe(400)
  })

  it('maps coordinator error codes even when the error is not this bundle\'s ReferenceInputError class', async () => {
    state.failure = Object.assign(new Error('Retained dataset inputs were explicitly released'), { code: 'DATASET_RELEASED' })
    expect((await get(fixture.id)).status).toBe(404)
    state.failure = Object.assign(new Error('A retained RAW archive failed its SHA-256 check'), { code: 'DATASET_CORRUPT' })
    expect((await get(fixture.id)).status).toBe(409)
    state.failure = new Error('Biometrics coordinator failed')
    expect((await get(fixture.id)).status).toBe(500)
  })

  it('returns 409 without streaming when a retained archive fails its hash check', async () => {
    tamper(fixture.artifacts[0].name)
    const response = await get(fixture.id)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('DATASET_CORRUPT') })
    // The failed attempt does not latch the one-at-a-time guard.
    tamper(fixture.artifacts[0].name)
    const retry = await get(fixture.id)
    expect(retry.status).toBe(200)
    await retry.arrayBuffer()
  })
})
