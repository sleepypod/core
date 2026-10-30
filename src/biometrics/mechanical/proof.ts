import { z } from 'zod'

const identity = z.string().uuid()
/** Historical rows without a receipt remain unqualified; never backfill proof. */
export function mechanicalWindowProof(flags: unknown, row: {
  timestampMs: number
  heartRate: number | null
  breathingRate: number | null
  hrv: number | null
}) {
  const values = z.array(z.string().max(512)).max(64).parse(flags)
  const receipts = values.filter(value => value.startsWith('mechanical_context_v1:'))
  if (receipts.length !== 1) throw new Error('Mechanical window receipt unavailable or ambiguous')
  const [version, epoch, spanId, from, through, extra] = receipts[0].split(':')
  identity.parse(epoch)
  identity.parse(spanId)
  const startMs = Number(from), endMs = Number(through)
  const duration = Math.max(row.heartRate === null ? 0 : 30_000,
    row.breathingRate === null ? 0 : 60_000, row.hrv === null ? 0 : 300_000)
  if (version !== 'mechanical_context_v1' || extra !== undefined || duration === 0
    || !/^\d+$/.test(from) || !/^\d+$/.test(through) || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
    || endMs < row.timestampMs + 1000 || endMs > row.timestampMs + 2000
    || endMs - startMs < duration + 2000 || endMs - startMs > duration + 2001) throw new Error('Invalid mechanical window receipt')
  return { epoch, spanId, startMs, endMs }
}
