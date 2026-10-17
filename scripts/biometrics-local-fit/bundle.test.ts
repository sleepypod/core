// @vitest-environment node
import { createWriteStream, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TAR_END, tarHeader, tarPadding } from '@/src/biometrics/backtest/bundle-tar'
import { datasetBundleChunks, prepareDatasetExport } from '@/src/biometrics/backtest/dataset-export'
import { exportableWaveformDataset } from '@/src/biometrics/backtest/tests/fixtures/export'
import { extractBundle, verifyBundle } from './bundle'

let directory: string
let fixture: ReturnType<typeof exportableWaveformDataset>
let tarPath: string
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'local-fit-bundle-'))
  fixture = exportableWaveformDataset(directory)
  const prepared = await prepareDatasetExport(fixture.db, fixture.id)
  tarPath = join(directory, 'bundle.tar')
  const out = createWriteStream(tarPath)
  for await (const chunk of datasetBundleChunks(prepared.index, { manifest: prepared.manifestText, snapshot: prepared.snapshotText }, fixture.rawDirectory)) out.write(chunk)
  out.end()
  await once(out, 'finish')
})
afterEach(() => {
  fixture.sqlite.close()
  rmSync(directory, { recursive: true, force: true })
})

const extract = () => extractBundle(tarPath, join(directory, `out-${Math.random().toString(16).slice(2)}`))
const flip = (path: string) => {
  const bytes = readFileSync(path)
  bytes[bytes.length - 1] ^= 0xff
  writeFileSync(path, bytes)
}

it('extracts and verifies an exported bundle end to end', async () => {
  const bundle = await verifyBundle(await extract())
  expect(bundle.index.dataset.contentHash).toBe(fixture.contentHash)
  expect(bundle.snapshot.version).toBe('waveform-dataset-v1')
  expect(bundle.manifest.splitProtocol.assignments.map(row => row.split)).toEqual(['tuning', 'validation', 'holdout'])
})

it('rejects a RAW archive whose bytes do not match the index', async () => {
  const root = await extract()
  flip(join(root, 'raw', fixture.artifacts[1].name))
  await expect(verifyBundle(root)).rejects.toThrow(`SHA-256 mismatch: raw/${fixture.artifacts[1].name}`)
})

it('rejects edited snapshots even when the index is rewritten to match', async () => {
  const root = await extract()
  const snapshot = JSON.parse(readFileSync(join(root, 'snapshot.json'), 'utf8'))
  snapshot.subjectId = 'someone else'
  const text = JSON.stringify(snapshot)
  writeFileSync(join(root, 'snapshot.json'), text)
  const index = JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8'))
  const { createHash } = await import('node:crypto')
  Object.assign(index.files[1], { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) })
  writeFileSync(join(root, 'bundle.json'), JSON.stringify(index))
  await expect(verifyBundle(root)).rejects.toThrow('content hash')
})

it('rejects files the index does not list, and missing or linked files', async () => {
  const root = await extract()
  writeFileSync(join(root, 'raw', fixture.unrelated.name), 'extra')
  await expect(verifyBundle(root)).rejects.toThrow('unlisted')
  rmSync(join(root, 'raw', fixture.unrelated.name))
  const raw = join(root, 'raw', fixture.artifacts[0].name)
  rmSync(raw)
  await expect(verifyBundle(root)).rejects.toThrow('missing')
  symlinkSync(join(fixture.rawDirectory, fixture.artifacts[0].name), raw)
  await expect(verifyBundle(root)).rejects.toThrow('not a regular file')
})

it('rejects a RAW set that differs from what the frozen snapshot references', async () => {
  const root = await extract()
  const index = JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8'))
  index.files = index.files.filter((file: { path: string }) => file.path !== `raw/${fixture.artifacts[2].name}`)
  writeFileSync(join(root, 'bundle.json'), JSON.stringify(index))
  rmSync(join(root, 'raw', fixture.artifacts[2].name))
  await expect(verifyBundle(root)).rejects.toThrow('not exactly the frozen dataset')
})

it('refuses tar entries that are unlisted, resized, links or outside the bundle', async () => {
  const index = readFileSync(tarPath).subarray(512, 512 + Number.parseInt(readFileSync(tarPath).subarray(124, 135).toString(), 8))
  const write = (entries: Buffer[]) => {
    tarPath = join(directory, `crafted-${Math.random().toString(16).slice(2)}.tar`)
    writeFileSync(tarPath, Buffer.concat([tarHeader('bundle.json', index.length), index, tarPadding(index.length), ...entries, TAR_END]))
  }
  write([tarHeader('notes.txt', 2), Buffer.from('hi'), tarPadding(2)])
  await expect(extract()).rejects.toThrow('Unlisted or resized bundle entry: notes.txt')
  write([tarHeader('manifest.json', 1), Buffer.from('x'), tarPadding(1)])
  await expect(extract()).rejects.toThrow('Unlisted or resized')
  const link = tarHeader('manifest.json', 0)
  link[156] = '2'.charCodeAt(0)
  let sum = 0
  link.fill(32, 148, 156)
  for (const byte of link) sum += byte
  link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  write([link])
  await expect(extract()).rejects.toThrow('only regular files')
  expect(() => tarHeader('../escape', 1)).toThrow('Invalid bundle entry name')
  write([])
  await expect(extract()).rejects.toThrow('missing')
})
