import { requireAccess } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'
import { NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const RAW_DIR = process.env.RAW_DATA_DIR ?? '/persistent'

/** Only allow alphanumeric, dash, underscore, dot — no path separators. */
const SAFE_FILENAME = /^[\w.-]+\.RAW$/i

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const denied = requireAccess(_request)
  if (denied) return denied
  const { filename } = await params

  if (!SAFE_FILENAME.test(filename)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
  }

  const resolved = path.resolve(RAW_DIR, filename)
  if (!resolved.startsWith(path.resolve(/* turbopackIgnore: true */ RAW_DIR))) {
    return NextResponse.json({ error: 'Path traversal detected' }, { status: 400 })
  }

  try {
    // Reject symlinks to prevent escaping RAW_DIR
    const lstats = await lstat(/* turbopackIgnore: true */ resolved)
    if (lstats.isSymbolicLink()) {
      return NextResponse.json({ error: 'Path traversal detected' }, { status: 400 })
    }

    // Verify canonical path is still inside RAW_DIR
    const canonicalFile = await realpath(/* turbopackIgnore: true */ resolved)
    const canonicalDir = await realpath(/* turbopackIgnore: true */ RAW_DIR)
    if (!canonicalFile.startsWith(canonicalDir)) {
      return NextResponse.json({ error: 'Path traversal detected' }, { status: 400 })
    }

    const s = await stat(/* turbopackIgnore: true */ resolved)
    const stream = createReadStream(/* turbopackIgnore: true */ resolved)
    const webStream = Readable.toWeb(stream) as ReadableStream

    return privateApiResponse(_request, new Response(webStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(s.size),
      },
    }))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 })
  }
}
