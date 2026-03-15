import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Serves a lightweight Scalar API reference page.
 * Scalar is loaded from CDN — no extra dependencies required.
 */
export function GET(req: NextRequest) {
  const specUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}/api/openapi.json`

  const html = `<!doctype html>
<html>
  <head>
    <title>Sleepypod Core API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="${specUrl}"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
