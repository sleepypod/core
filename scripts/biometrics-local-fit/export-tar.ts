import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'

const BLOCK = 512
const MAX_RAW_BYTES = 256 * 1024 * 1024
/** GET /api/export/archive writes ./raw/<NAME>.RAW.gz under the pod's original names. */
const RAW_ENTRY = /^(?:\.\/)?raw\/([A-Za-z0-9_.-]+\.RAW\.gz)$/

export interface ExportedRaw { sha256: string, name: string, mtimeMs: number, path: string, bytes: number }

/** Byte-exact reads over a stream of chunks. */
async function* blocks(source: AsyncIterable<Buffer>) {
  let pending: Buffer = Buffer.alloc(0)
  let wanted = BLOCK
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= wanted) {
      const next: number | undefined = yield pending.subarray(0, wanted)
      pending = pending.subarray(wanted)
      wanted = next ?? BLOCK
    }
  }
  if (pending.length) throw new Error('Truncated export archive')
}

function header(block: Buffer) {
  if (block.every(byte => byte === 0)) return null
  const text = (offset: number, length: number) => block.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/s, '')
  let sum = 0
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 32 : block[index]
  if (Number.parseInt(text(148, 8).trim(), 8) !== sum) throw new Error('Export archive header checksum mismatch')
  if (!text(257, 6).startsWith('ustar')) throw new Error('Export archive is not a ustar tar')
  const prefix = text(345, 155)
  const bytes = Number.parseInt(text(124, 12).trim(), 8)
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid export archive entry size')
  return { name: prefix ? `${prefix}/${text(0, 100)}` : text(0, 100), type: text(156, 1), bytes, mtimeMs: Number.parseInt(text(136, 12).trim(), 8) * 1000 }
}

/** Unpack the RAW files of an export archive (gzip or plain tar) into
 * DESTINATION/<sha256>.RAW.gz, hashing each as it is written. Directories and
 * every other entry are skipped; nothing outside DESTINATION is written. */
export async function extractExportRaw(tarPath: string, destination: string): Promise<ExportedRaw[]> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const magic = Buffer.alloc(2)
  const probe = await open(tarPath, 'r')
  try {
    await probe.read(magic, 0, 2, 0)
  }
  finally {
    await probe.close()
  }
  const input = createReadStream(tarPath, { highWaterMark: 1024 * 1024 })
  const stream = magic[0] === 0x1f && magic[1] === 0x8b ? input.pipe(createGunzip()) : input
  const reader = blocks(stream as AsyncIterable<Buffer>)
  const files: ExportedRaw[] = []
  const names = new Set<string>()
  for (let block = await reader.next(); !block.done; block = await reader.next()) {
    const entry = header(block.value)
    if (!entry) break
    const padded = Math.ceil(entry.bytes / BLOCK) * BLOCK
    const match = RAW_ENTRY.exec(entry.name)
    if (!padded) continue
    if (!match || (entry.type !== '0' && entry.type !== '')) {
      await reader.next(padded)
      continue
    }
    if (entry.bytes > MAX_RAW_BYTES) throw new Error(`Export RAW file is too large: ${match[1]}`)
    if (names.has(match[1])) throw new Error(`Export archive lists ${match[1]} twice`)
    names.add(match[1])
    const data = await reader.next(padded)
    if (data.done) throw new Error('Truncated export archive')
    const bytes = data.value.subarray(0, entry.bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const partial = join(destination, `${match[1]}.part`)
    const handle = await open(partial, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
    }
    finally {
      await handle.close()
    }
    const path = join(destination, `${sha256}.RAW.gz`)
    await rename(partial, path)
    files.push({ sha256, name: match[1], mtimeMs: entry.mtimeMs, path, bytes: entry.bytes })
  }
  await reader.return(undefined)
  input.destroy()
  if (!files.length) throw new Error(`Export archive ${tarPath} holds no raw/*.RAW.gz files`)
  return files
}
