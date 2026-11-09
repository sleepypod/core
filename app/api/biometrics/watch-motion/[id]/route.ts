import { biometricsDb } from '@/src/db'
import { getWatchMotionFile } from '@/src/biometrics/references/watch-motion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The stored, trimmed canonical file: byte-for-byte what training imports. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params
  if (!/^[1-9]\d{0,15}$/.test(id)) return Response.json({ error: 'Invalid id' }, { status: 400 })
  const file = getWatchMotionFile(biometricsDb, Number(id))
  if (file === null) return Response.json({ error: 'Not found' }, { status: 404 })
  return new Response(file, { headers: { 'Content-Type': 'application/json' } })
}
