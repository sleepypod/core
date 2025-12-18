import linguiConfig from 'lingui.config'
import Negotiator from 'negotiator'
import { type NextRequest, NextResponse } from 'next/server'

const { locales } = linguiConfig

const getRequestLocale = (requestHeaders: Headers): string => {
  const langHeader = requestHeaders.get('accept-language') || undefined
  const languages = new Negotiator({
    headers: { 'accept-language': langHeader },
  }).languages(locales.slice())

  // Ensure the locale is valid, default to the first locale in `linguiConfig.locales`
  const activeLocale = languages.find(lang => locales.includes(lang)) || locales[0] || 'en'

  return activeLocale
}

export const proxy = (request: NextRequest) => {
  const { pathname } = request.nextUrl

  console.log('Current pathname:', pathname)
  const pathnameHasLocale = locales.some(
    locale => pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`,
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

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
