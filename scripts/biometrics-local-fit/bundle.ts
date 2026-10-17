import { createHash } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { dataHash } from '@/src/biometrics/algorithms/canonical'
import { parseTarHeader } from '@/src/biometrics/backtest/bundle-tar'
import { datasetManifestSchema, datasetSnapshotSchema } from '@/src/biometrics/backtest/contracts'
import { DATASET_BUNDLE_INDEX_PATH, datasetBundleIndexSchema, type DatasetBundleIndex } from '@/src/biometrics/backtest/dataset-export'

const MAX_INDEX_BYTES = 1024 * 1024
const MAX_TEXT_BYTES = 16 * 1024 * 1024
const MAX_RAW_BYTES = 256 * 1024 * 1024

export class BundleError extends Error {}

async function sha256File(path: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, position: number, length: number) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) throw new BundleError('Truncated bundle archive')
  return buffer
}

/** Unpack an export tar into a new directory. Only the index and the files it
 * lists are accepted, each once and at its listed size; verifyBundle then
 * checks every hash. */
export async function extractBundle(tarPath: string, destination: string) {
  await mkdir(destination, { recursive: false, mode: 0o700 })
  await mkdir(join(destination, 'raw'), { mode: 0o700 })
  const handle = await open(tarPath, constants.O_RDONLY)
  try {
    const total = (await handle.stat()).size
    let position = 0, index: DatasetBundleIndex | undefined
    const expected = new Map<string, number>(), seen = new Set<string>()
    for (;;) {
      const header = parseTarHeader(await readExactly(handle, position, 512))
      position += 512
      if (!header) break
      if (seen.has(header.name)) throw new BundleError(`Duplicate bundle entry: ${header.name}`)
      seen.add(header.name)
      if (!index) {
        if (header.name !== DATASET_BUNDLE_INDEX_PATH || header.bytes > MAX_INDEX_BYTES) throw new BundleError('Bundle must start with its bundle.json index')
        const text = await readExactly(handle, position, header.bytes)
        index = datasetBundleIndexSchema.parse(JSON.parse(text.toString('utf8')))
        for (const file of index.files) expected.set(file.path, file.bytes)
        await writeFile(join(destination, DATASET_BUNDLE_INDEX_PATH), text, { flag: 'wx', mode: 0o600 })
      }
      else {
        if (expected.get(header.name) !== header.bytes) throw new BundleError(`Unlisted or resized bundle entry: ${header.name}`)
        if (position + header.bytes > total) throw new BundleError('Truncated bundle archive')
        await pipeline(createReadStream('', { fd: handle.fd, autoClose: false, start: position, end: position + header.bytes - 1 }),
          createWriteStream(join(destination, header.name), { flags: 'wx', mode: 0o600 }))
      }
      position += Math.ceil(header.bytes / 512) * 512
    }
    if (!index) throw new BundleError('Bundle has no index')
    const missing = index.files.filter(file => !seen.has(file.path))
    if (missing.length) throw new BundleError(`Bundle is missing ${missing.length} listed file(s), e.g. ${missing[0].path}`)
  }
  finally {
    await handle.close()
  }
  return destination
}

/** Check a bundle directory against its index: exact file set, sizes and
 * SHA-256s, the dataset's own content hash, and that the RAW archives are
 * exactly the ones the frozen snapshot references. */
export async function verifyBundle(directory: string) {
  const indexPath = join(directory, DATASET_BUNDLE_INDEX_PATH)
  if ((await stat(indexPath)).size > MAX_INDEX_BYTES) throw new BundleError('Bundle index is too large')
  const index = datasetBundleIndexSchema.parse(JSON.parse(await readFile(indexPath, 'utf8')))
  const listed = new Set(index.files.map(file => file.path))
  if (listed.size !== index.files.length) throw new BundleError('Bundle index lists a file twice')
  const present = [
    ...(await readdir(directory)).filter(name => name !== 'raw'),
    ...(await readdir(join(directory, 'raw')).catch(() => [] as string[])).map(name => `raw/${name}`),
  ]
  const extra = present.filter(name => name !== DATASET_BUNDLE_INDEX_PATH && !listed.has(name))
  if (extra.length) throw new BundleError(`Bundle contains unlisted file(s), e.g. ${extra[0]}`)
  for (const file of index.files) {
    const path = join(directory, file.path)
    const info = await lstat(path).catch(() => null)
    if (!info?.isFile()) throw new BundleError(`Bundle file is missing or not a regular file: ${file.path}`)
    const limit = file.role === 'raw' ? MAX_RAW_BYTES : MAX_TEXT_BYTES
    if (info.size !== file.bytes || info.size > limit) throw new BundleError(`Bundle file size mismatch: ${file.path}`)
    if (await sha256File(path) !== file.sha256) throw new BundleError(`Bundle file SHA-256 mismatch: ${file.path}`)
  }
  const text = (role: 'manifest' | 'snapshot') => readFile(join(directory, index.files.find(file => file.role === role)?.path ?? ''), 'utf8')
  const manifest = datasetManifestSchema.parse(JSON.parse(await text('manifest')))
  const snapshot = datasetSnapshotSchema.parse(JSON.parse(await text('snapshot')))
  if (dataHash({ manifest, snapshot }) !== index.dataset.contentHash) throw new BundleError('Dataset content hash does not match its manifest and snapshot')
  if (snapshot.side !== index.dataset.side || snapshot.version !== index.dataset.snapshotVersion) throw new BundleError('Bundle index does not describe this snapshot')
  const frozen = new Map(snapshot.version === 'waveform-dataset-v1'
    ? snapshot.waveformInputs.flatMap(cohort => cohort.input.artifacts.map(source => [source.artifact.sha256, source.artifact] as const))
    : [])
  const raw = index.files.filter(file => file.role === 'raw')
  if (raw.length !== frozen.size || raw.some((file) => {
    const artifact = frozen.get(file.sha256)
    return !artifact || artifact.compressed_bytes !== file.bytes || artifact.expanded_bytes !== file.expandedBytes
  })) throw new BundleError('Bundle RAW archives are not exactly the frozen dataset\'s archives')
  return { index, manifest, snapshot, rawDirectory: join(directory, 'raw') }
}
export type VerifiedBundle = Awaited<ReturnType<typeof verifyBundle>>
