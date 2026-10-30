import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'

export const BROWSER_SCOPE_COOKIE = 'sleepypod_browser_scope'
const SCOPE_SECONDS = 30 * 24 * 60 * 60
type ScopeKind = 'owner' | 'personal' | 'signed_out'
export class BrowserScopeConflict extends Error {}
interface ScopeRow { kind: ScopeKind, session_hash: string, expires_at: number }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function scopeKey(headers: Headers): string | null {
  const matches = (headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${BROWSER_SCOPE_COOKIE}=`))
  const key = matches.length === 1 ? matches[0].slice(BROWSER_SCOPE_COOKIE.length + 1) : ''
  return /^[\w-]{43}$/.test(key) ? key : null
}

export function hasBrowserScope(headers: Headers): boolean {
  return (headers.get('cookie') ?? '').split(';').some(value => value.trim().startsWith(`${BROWSER_SCOPE_COOKIE}=`))
}

/** Short independent connections share persisted scope across Next proxy/route workers. */
function withDatabase<T>(readOnly: boolean, operation: (database: Database.Database) => T): T {
  const path = process.env.DATABASE_URL?.replace(/^file:/, '') || './sleepypod.dev.db'
  const database = new Database(path, { readonly: readOnly, fileMustExist: true })
  try {
    database.pragma('busy_timeout = 5000')
    return operation(database)
  }
  finally { database.close() }
}

function readScope(headers: Headers): ScopeRow | null {
  const key = scopeKey(headers)
  if (!key) return null
  try {
    return withDatabase(true, database => database.prepare('SELECT kind, session_hash, expires_at FROM household_browser_scopes WHERE key_hash = ? AND expires_at > ?').get(digest(key), Date.now()) as ScopeRow | undefined) ?? null
  }
  catch { return null }
}

export function personalBrowserScopeActive(headers: Headers): boolean {
  return hasBrowserScope(headers) && readScope(headers)?.kind !== 'owner'
}

export function browserScopeRevision(headers: Headers): string | null {
  return readScope(headers)?.session_hash ?? null
}

/** A delayed Set-Cookie response cannot revive a superseded browser identity. */
export function browserScopeAllows(headers: Headers, kind: 'owner' | 'personal', session: string): boolean {
  if (!hasBrowserScope(headers)) return kind === 'owner'
  const scope = readScope(headers)
  return scope?.kind === kind && scope.session_hash === digest(session)
}

export function bindBrowserScope(request: Request, kind: ScopeKind, session: string, connection?: Database.Database): string {
  const key = scopeKey(request.headers) ?? randomBytes(32).toString('base64url')
  const now = Date.now()
  const persist = (database: Database.Database) => {
    database.transaction(() => {
      database.prepare('DELETE FROM household_browser_scopes WHERE expires_at <= ?').run(now)
      const current = database.prepare('SELECT session_hash FROM household_browser_scopes WHERE key_hash = ?').get(digest(key)) as { session_hash: string } | undefined
      if (current && request.headers.get('x-sleepypod-browser-revision') !== current.session_hash)
        throw new BrowserScopeConflict('The browser account changed. Retry explicitly with its current state.')
      database.prepare('INSERT INTO household_browser_scopes (key_hash, kind, session_hash, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key_hash) DO UPDATE SET kind = excluded.kind, session_hash = excluded.session_hash, expires_at = excluded.expires_at')
        .run(digest(key), kind, digest(kind === 'signed_out' ? randomBytes(32).toString('base64url') : session), now + SCOPE_SECONDS * 1000)
    }).immediate()
  }
  if (connection) persist(connection)
  else withDatabase(false, persist)
  const secure = new URL(request.url).protocol === 'https:' || process.env.SLEEPYPOD_HTTPS_ONLY === '1'
  return `${BROWSER_SCOPE_COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SCOPE_SECONDS}${secure ? '; Secure' : ''}`
}
