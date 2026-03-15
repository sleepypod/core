import { NextResponse } from 'next/server'
import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

const RAW_DIR = process.env.RAW_DATA_DIR ?? '/persistent'

/** Only allow alphanumeric, dash, underscore, dot — no path separators. */
const SAFE_FILENAME = /^[\w.-]+\.RAW$/i

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params

  if (!SAFE_FILENAME.test(filename)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
  }

  const resolved = path.resolve(RAW_DIR, filename)
  if (!resolved.startsWith(path.resolve(RAW_DIR))) {
    return NextResponse.json({ error: 'Path traversal detected' }, { status: 400 })
  }

  try {
    const s = statSync(resolved)
    const stream = createReadStream(resolved)
    const webStream = Readable.toWeb(stream) as ReadableStream

    return new Response(webStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(s.size),
      },
    })
  }
  catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }
}
