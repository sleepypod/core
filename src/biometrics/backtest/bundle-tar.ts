/** Minimal ustar framing for calibration bundles: regular files with short,
 * relative names only. Writer and reader live together so their limits agree. */
const BLOCK = 512
const NAME = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/
export const TAR_END = Buffer.alloc(BLOCK * 2)

function field(header: Buffer, offset: number, length: number, value: string) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'ascii')
}

function octal(value: number, digits: number) {
  return value.toString(8).padStart(digits, '0')
}

export function tarHeader(name: string, bytes: number, mtimeSeconds = 0) {
  if (!NAME.test(name) || name.length > 100 || name.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid bundle entry name')
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes >= 8 ** 11) throw new Error('Invalid bundle entry size')
  const header = Buffer.alloc(BLOCK)
  field(header, 0, 100, name)
  field(header, 100, 8, '0000600\0')
  field(header, 108, 8, '0000000\0')
  field(header, 116, 8, '0000000\0')
  field(header, 124, 12, `${octal(bytes, 11)}\0`)
  field(header, 136, 12, `${octal(Math.max(0, Math.floor(mtimeSeconds)), 11)}\0`)
  field(header, 148, 8, '        ')
  field(header, 156, 1, '0')
  field(header, 257, 6, 'ustar\0')
  field(header, 263, 2, '00')
  let sum = 0
  for (const byte of header) sum += byte
  field(header, 148, 8, `${octal(sum, 6)}\0 `)
  return header
}

export function tarPadding(bytes: number) {
  return Buffer.alloc((BLOCK - (bytes % BLOCK)) % BLOCK)
}

export interface TarEntryHeader { name: string, bytes: number }

/** Parse one header block. Returns null for the zero end-of-archive block and
 * rejects anything other than a checksummed regular file with a safe name. */
export function parseTarHeader(block: Buffer): TarEntryHeader | null {
  if (block.length !== BLOCK) throw new Error('Truncated bundle archive')
  if (block.every(byte => byte === 0)) return null
  const text = (offset: number, length: number) => block.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/s, '')
  let sum = 0
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 32 : block[index]
  if (Number.parseInt(text(148, 8).trim(), 8) !== sum) throw new Error('Bundle archive header checksum mismatch')
  if (!text(257, 6).startsWith('ustar')) throw new Error('Bundle archive is not ustar')
  const type = text(156, 1)
  if (type !== '0' && type !== '') throw new Error('Bundle archive may contain only regular files')
  if (text(345, 155)) throw new Error('Bundle archive entry names must be short')
  const name = text(0, 100)
  if (!NAME.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw new Error('Unsafe bundle archive entry name')
  const bytes = Number.parseInt(text(124, 12).trim(), 8)
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid bundle archive entry size')
  return { name, bytes }
}
