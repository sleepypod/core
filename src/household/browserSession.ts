import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { authConfigured, sameOrigin, PERSONAL_SESSION_COOKIE } from '@/src/auth/access'
import { browserScopeAllows } from '@/src/auth/browserScope'
import { householdIdSchema, deviceSecretSchema } from './contract'
import { HouseholdError, type HouseholdCredential } from './store'
export const PERSONAL_COOKIE = PERSONAL_SESSION_COOKIE
export const PERSONAL_SESSION_SECONDS = 12 * 60 * 60
function sign(payload: string) {
  const key = process.env.SLEEPYPOD_AUTH_TOKEN
  if (!authConfigured() || !key)
    throw new HouseholdError('not_ready', 503, 'Owner authentication must be configured first.')
  return createHmac('sha256', key).update(`personal-session-v1:${payload}`).digest('base64url')
}
/** Cookie contains a device identifier and expiration, never a reusable personal key. */
export function issuePersonalSession(deviceId: string, now = Date.now()) {
  householdIdSchema.parse(deviceId)
  const payload = `${deviceId}.${Math.floor(now / 1000) + PERSONAL_SESSION_SECONDS}.${randomBytes(24).toString('base64url')}`
  return `${payload}.${sign(payload)}`
}
export function personalCredential(request: Request, now = Date.now()): HouseholdCredential {
  if (request.headers.has('origin') && !sameOrigin(request.headers))
    throw new HouseholdError('forbidden', 403, 'Use the same private Pod origin.')
  const authorization = request.headers.get('authorization')
  if (authorization !== null) {
    const secret = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!deviceSecretSchema.safeParse(secret).success)
      throw new HouseholdError('authentication_required', 401, 'Use your personal connection key.')
    return secret
  }
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${PERSONAL_COOKIE}=`))
  const value = cookies.length === 1 ? cookies[0].slice(PERSONAL_COOKIE.length + 1) : ''
  const [deviceId, expiry, nonce, signature, extra] = value.split('.')
  if (value.length > 240 || extra !== undefined || !householdIdSchema.safeParse(deviceId).success || !/^\d+$/.test(expiry ?? '') || !/^[\w-]{32}$/.test(nonce ?? '') || !/^[\w-]{43}$/.test(signature ?? ''))
    throw new HouseholdError('authentication_required', 401, 'Reconnect your personal account.')
  const remaining = Number(expiry) - Math.floor(now / 1000)
  if (remaining <= 0 || remaining > PERSONAL_SESSION_SECONDS || !Number.isSafeInteger(remaining))
    throw new HouseholdError('authentication_required', 401, 'Your personal browser session expired.')
  const expected = sign(`${deviceId}.${expiry}.${nonce}`)
  if (!timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(signature).digest()))
    throw new HouseholdError('authentication_required', 401, 'Reconnect your personal account.')
  if (!browserScopeAllows(request.headers, 'personal', value))
    throw new HouseholdError('authentication_required', 401, 'The browser account changed. Reconnect your personal account.')
  if (!['GET', 'HEAD'].includes(request.method) && !sameOrigin(request.headers))
    throw new HouseholdError('forbidden', 403, 'A same-origin browser request is required.')
  return { deviceId }
}
export function personalCookie(request: Request, value: string, seconds = PERSONAL_SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' || process.env.SLEEPYPOD_HTTPS_ONLY === '1'
  // Legacy routes must see this scope marker too, so they can suppress any
  // delayed owner-cookie response while a personal account is open.
  return `${PERSONAL_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`
}
