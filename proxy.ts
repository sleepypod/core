import linguiConfig from 'lingui.config'
import Negotiator from 'negotiator'
import { type NextRequest, NextResponse } from 'next/server'
import { ALLOWED_HOSTS_ENV, isHostAllowed, parseAllowedHosts } from '@/src/lib/hostAllowlist'

const { locales } = linguiConfig

// Paths served without a locale prefix:
//   api    — tRPC + REST endpoints, no locale needed
//   panel  — tRPC panel dev tool, served as a plain route handler
//   vendor — static vendored scripts in public/vendor (three.js fallback)
const NO_LOCALE_PATH = /^\/(?:api|panel(?:\/|$)|vendor\/)/

const getRequestLocale = (requestHeaders: Headers): string => {
  const langHeader = requestHeaders.get('accept-language') || undefined
  const languages = new Negotiator({
    headers: { 'accept-language': langHeader },
  }).languages(locales.slice())

  // Ensure the locale is valid, default to the first locale in `linguiConfig.locales`
  const activeLocale = languages.find(lang => locales.includes(lang)) || locales[0] || 'en'

  return activeLocale
}

// DNS-rebinding guard (see src/lib/hostAllowlist.ts). A request without a
// Host header passes: Node rejects HTTP/1.1 requests that lack one, and the
// browsers that carry a rebinding attack always send it, so only HTTP/1.0
// tools get here without one. The Vercel demo is served from a public domain
// with no pod behind it, so it skips the check.
const rejectUnknownHost = (request: NextRequest): NextResponse | undefined => {
  if (process.env.NEXT_PUBLIC_DEMO === '1') return
  const host = request.headers.get('host')
  if (host === null) return
  if (isHostAllowed(host, parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]))) return
  return new NextResponse(
    `Host not allowed. Use the pod's IP address, or add this host to ${ALLOWED_HOSTS_ENV}.\n`,
    { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  )
}

export const proxy = (request: NextRequest) => {
  const rejected = rejectUnknownHost(request)
  if (rejected) {
    return rejected
  }

  const { pathname } = request.nextUrl

  if (NO_LOCALE_PATH.test(pathname)) {
    return
  }

  console.log('Current pathname:', pathname)
  const pathnameHasLocale = locales.some(
    (locale: string) => pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`,
  )

  console.log('Pathname has locale:', pathnameHasLocale)
  if (pathnameHasLocale) {
    return
  }

  // Redirect if there is no locale
  const locale = getRequestLocale(request.headers)
  console.log('Redirecting to locale:', locale) // Debugging: Log the locale being redirected to

  request.nextUrl.pathname = `/${locale}${pathname}`

  return NextResponse.redirect(request.nextUrl)
}

// Every API route and page runs the Host check. Build output and images are
// left out: they carry no pod data.
export const config = {
  matcher: [
    '/api/:path*',
    '/((?!api|_vercel|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
