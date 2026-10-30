import Database from 'better-sqlite3'

export type LegacyPrivacyState = 'legacy' | 'personal_required' | 'unavailable'

/** Read on every request/output. Turning flags off cannot reopen a private bed. */
export function legacyPrivacyState(path = process.env.DATABASE_URL?.replace(/^file:/, '') || './sleepypod.dev.db'): LegacyPrivacyState {
  let database: Database.Database | undefined
  try {
    database = new Database(path, { readonly: true, fileMustExist: true })
    database.pragma('busy_timeout = 100')
    const tables = database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name IN (\'household_accounts\', \'household_privacy_boundary\')').all() as { name: string }[]
    if (tables.some(table => table.name === 'household_privacy_boundary'))
      return database.prepare('SELECT id FROM household_privacy_boundary LIMIT 1').get() ? 'personal_required' : 'legacy'
    // A pre-household database has no partner identities. A partial household
    // migration is unavailable, never permission to skip the privacy boundary.
    return tables.length === 0 ? 'legacy' : 'unavailable'
  }
  catch { return 'unavailable' }
  finally { database?.close() }
}

export function legacyPrivacyDenial(): Response | null {
  const state = legacyPrivacyState()
  if (state === 'legacy') return null
  return Response.json({
    error: state === 'personal_required'
      ? 'Connect with your personal account. This bed no longer permits shared owner-key access.'
      : 'The controller cannot verify the personal privacy boundary. Try again when its storage is available.',
    code: state === 'personal_required' ? 'personal_connection_required' : 'privacy_unavailable',
    personalWorkspace: '/household/index.html',
  }, { status: state === 'personal_required' ? 403 : 503, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization, Cookie' } })
}
