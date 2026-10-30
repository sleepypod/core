import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { browserScopeAllows, hasBrowserScope } from './browserScope'
import { legacyPrivacyDenial, legacyPrivacyState } from '@/src/household/legacyPrivacy'

export const SESSION_COOKIE = 'sleepypod_session'
export const PERSONAL_SESSION_COOKIE = 'sleepypod_personal_session'
export const SESSION_SECONDS = 12 * 60 * 60
const TOKEN_MIN_LENGTH = 32

function ownerToken(): string | null {
  const token = process.env.SLEEPYPOD_AUTH_TOKEN
  return token && token.length >= TOKEN_MIN_LENGTH ? token : null
}

function equalSecret(received: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(received).digest(), createHash('sha256').update(expected).digest())
}

export function authConfigured(): boolean {
  return ownerToken() !== null
}

export function validOwnerToken(received: unknown): boolean {
  const token = ownerToken()
  return token !== null && typeof received === 'string' && received.length <= 4096 && equalSecret(received, token)
}

/** Signed, expiring browser credentials never contain the owner's API token. Rotation invalidates them. */
export function issueSession(now = Date.now(), scoped = false): string {
  const token = ownerToken()
  if (!token) throw new Error('Owner authentication is not configured')
  const payload = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(24).toString('base64url')}`
  const version = scoped ? 'v2' : 'v1'
  const signature = createHmac('sha256', token).update(`sleepypod-session-${version}:${payload}`).digest('base64url')
  return `${scoped ? 'v2.' : ''}${payload}.${signature}`
}

function validSession(received: string, now = Date.now()): boolean {
  const token = ownerToken()
  if (!token || received.length > 256) return false
  const scoped = received.startsWith('v2.')
  const [expires, nonce, signature, extra] = (scoped ? received.slice(3) : received).split('.')
  if (extra !== undefined || !/^\d+$/.test(expires ?? '') || !/^[\w-]{32}$/.test(nonce ?? '') || !signature) return false
  const remaining = Number(expires) - Math.floor(now / 1000)
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > SESSION_SECONDS) return false
  const expected = createHmac('sha256', token).update(`sleepypod-session-${scoped ? 'v2' : 'v1'}:${expires}.${nonce}`).digest('base64url')
  return equalSecret(signature, expected)
}

export function sameOrigin(headers: Headers, allowDifferentPort = false): boolean {
  const origin = headers.get('origin')
  const host = headers.get('host')
  if (!origin || !host) return false
  try {
    const source = new URL(origin)
    if (!['http:', 'https:'].includes(source.protocol)) return false
    return allowDifferentPort ? source.hostname === new URL(`http://${host}`).hostname : source.host === host
  }
  catch { return false }
}

/** Cookie-authenticated writes and streams also require an explicit same-host browser origin. */
export function authorized(headers: Headers, method = 'GET', streaming = false): boolean {
  const authorization = headers.get('authorization')
  if (authorization !== null) {
    return authorization.startsWith('Bearer ') && validOwnerToken(authorization.slice(7))
      && (!headers.has('origin') || sameOrigin(headers, streaming))
  }
  const cookies = (headers.get('cookie') ?? '').split(';').map(cookie => cookie.trim())
  // An older owner login response must not reactivate owner APIs after a
  // personal account switch in another tab. Explicit owner reconnection clears it.
  if (!hasBrowserScope(headers) && cookies.some(cookie => cookie.startsWith(`${PERSONAL_SESSION_COOKIE}=`))) return false
  const matches = cookies.filter(cookie => cookie.startsWith(`${SESSION_COOKIE}=`))
  if (matches.length !== 1 || !validSession(matches[0].slice(SESSION_COOKIE.length + 1))) return false
  const session = matches[0].slice(SESSION_COOKIE.length + 1)
  if (session.startsWith('v2.') && !hasBrowserScope(headers)) return false
  if (!session.startsWith('v2.') && process.env.SLEEPYPOD_HOUSEHOLD_PREPARATION === '1') return false
  if (!browserScopeAllows(headers, 'owner', session)) return false
  if (streaming || !['GET', 'HEAD'].includes(method.toUpperCase())) return sameOrigin(headers, streaming)
  return !headers.has('origin') || sameOrigin(headers)
}

export function requireAccess(request: Request): Response | null {
  if (authorized(request.headers, request.method)) return legacyPrivacyDenial()
  return Response.json({ error: authConfigured() ? 'Authentication required' : 'Owner authentication is not configured' }, {
    status: authConfigured() ? 401 : 503,
    headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' },
  })
}

/** Raw streams are an owner legacy surface, never a personal data channel. */
export function legacyStreamAuthorized(headers: Headers): boolean {
  return authorized(headers, 'GET', true) && legacyPrivacyState() === 'legacy'
}
