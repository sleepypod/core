import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getOpenApiDocument } from '@/src/server/openapi'

export function GET(req: NextRequest) {
  const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`
  const document = getOpenApiDocument(baseUrl)

  return NextResponse.json(document, {
    headers: { 'Cache-Control': 'public, max-age=60' },
  })
}
