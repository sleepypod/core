import { authConfigured, authorized, issueSession, sameOrigin, SESSION_COOKIE, SESSION_SECONDS, PERSONAL_SESSION_COOKIE, validOwnerToken } from '@/src/auth/access'
import { bindBrowserScope, hasBrowserScope, personalBrowserScopeActive, browserScopeRevision, BrowserScopeConflict } from '@/src/auth/browserScope'
import { legacyPrivacyDenial, legacyPrivacyState } from '@/src/household/legacyPrivacy'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  const personalSessionActive = hasBrowserScope(request.headers) ? personalBrowserScopeActive(request.headers) : (request.headers.get('cookie') ?? '').split(';').some(value => value.trim().startsWith(`${PERSONAL_SESSION_COOKIE}=`))
  const privacy = legacyPrivacyState()
  return Response.json({ configured: authConfigured(), authenticated: authorized(request.headers) && privacy === 'legacy', personalSessionActive,
    personalConnectionRequired: privacy === 'personal_required', privacyAvailable: privacy !== 'unavailable', browserScopeRevision: browserScopeRevision(request.headers) }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(request: Request) {
  if (!sameOrigin(request.headers)) return Response.json({ error: 'Same-origin connection required' }, { status: 403 })
  if (!authConfigured()) return Response.json({ error: 'Configure SLEEPYPOD_AUTH_TOKEN on the controller first' }, { status: 503 })
  if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response(null, { status: 415 })
  // Stream a bounded login body; an absent Content-Length must not allow unlimited buffering.
  const reader = request.body?.getReader()
  if (!reader) return new Response(null, { status: 400 })
  let body = ''
  const decoder = new TextDecoder()
  let exitPersonalSession = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        body += decoder.decode()
        break
      }
      body += decoder.decode(chunk.value, { stream: true })
      if (body.length > 8192) {
        await reader.cancel()
        return new Response(null, { status: 413 })
      }
    }
    const value = JSON.parse(body) as { token?: unknown, exitPersonalSession?: unknown }
    if (!validOwnerToken(value?.token)) return Response.json({ error: 'Invalid connection key' }, { status: 401 })
    exitPersonalSession = value.exitPersonalSession === true
  }
  catch { return new Response(null, { status: 400 }) }
  const denied = legacyPrivacyDenial()
  if (denied) return denied
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  const preparation = process.env.SLEEPYPOD_HOUSEHOLD_PREPARATION === '1'
  const session = issueSession(Date.now(), preparation || exitPersonalSession || hasBrowserScope(request.headers))
  if (exitPersonalSession || (!personalBrowserScopeActive(request.headers) && (preparation || hasBrowserScope(request.headers)))) {
    try {
      headers.append('Set-Cookie', bindBrowserScope(request, 'owner', session))
    }
    catch (error) { return Response.json({ error: 'Browser account state changed or is unavailable. Reconnect explicitly.' }, { status: error instanceof BrowserScopeConflict ? 409 : 503 }) }
  }
  headers.append('Set-Cookie', sessionCookie(request, session, SESSION_SECONDS))
  // Deliberately reconnecting the owner also leaves the personal browser scope.
  if (exitPersonalSession) headers.append('Set-Cookie', `${PERSONAL_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
  return Response.json({ authenticated: true }, { headers })
}

export function DELETE(request: Request) {
  if (!sameOrigin(request.headers)) return new Response(null, { status: 403 })
  if (hasBrowserScope(request.headers)) {
    try {
      bindBrowserScope(request, 'signed_out', '')
    }
    catch (error) { return new Response(null, { status: error instanceof BrowserScopeConflict ? 409 : 503 }) }
  }
  return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie(request, '', 0), 'Cache-Control': 'no-store' } })
}

function sessionCookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === 'https:' || process.env.SLEEPYPOD_HTTPS_ONLY === '1'
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}
