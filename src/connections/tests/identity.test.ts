import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionChallengeSchema, connectionIdentitySchema, readOrCreateConnectionIdentity } from '../identity'

const directories: string[] = []
const open: Database.Database[] = []
afterEach(() => {
  for (const database of open.splice(0)) {
    if (database.open) database.close()
  }
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})
function database(path = ':memory:') {
  const result = new Database(path)
  open.push(result)
  if (!result.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'controller_connection_identity\'').get()) {
    result.exec(readFileSync('src/db/migrations/0060_controller_connection_identity.sql', 'utf8'))
  }
  return result
}

describe('logical controller installation identity', () => {
  it('creates one stable UUID, independent of request challenge or software process', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sleepypod-identity-'))
    directories.push(directory)
    const path = join(directory, 'identity.db'), original = database(path)
    const identity = readOrCreateConnectionIdentity(original)
    expect(identity).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    expect(readOrCreateConnectionIdentity(original)).toBe(identity)
    expect(original.prepare('SELECT count(*) AS count FROM controller_connection_identity').get()).toEqual({ count: 1 })
    original.close()
    expect(readOrCreateConnectionIdentity(database(path))).toBe(identity)
    const readonly = new Database(path, { readonly: true })
    open.push(readonly)
    expect(readOrCreateConnectionIdentity(readonly)).toBe(identity)
    expect(readOrCreateConnectionIdentity(database())).not.toBe(identity)
  })

  it('preserves the logical installation when restoring its database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sleepypod-identity-restore-'))
    directories.push(directory)
    const original = database(join(directory, 'original.db')), identity = readOrCreateConnectionIdentity(original)
    const restoredPath = join(directory, 'restored.db')
    await original.backup(restoredPath)
    expect(readOrCreateConnectionIdentity(database(restoredPath))).toBe(identity)
  })

  it.each(['not-a-uuid', '', 'sleepypod-core'])('refuses corrupt stored identity without overwriting it: %s', (identity) => {
    const stored = database()
    stored.prepare('INSERT INTO controller_connection_identity VALUES (1, ?, 1)').run(identity)
    expect(() => readOrCreateConnectionIdentity(stored)).toThrow()
    expect(stored.prepare('SELECT installation_id AS identity FROM controller_connection_identity').get()).toEqual({ identity })
  })

  it('does not replace a misplaced or duplicated singleton', () => {
    const stored = database()
    stored.prepare('INSERT INTO controller_connection_identity VALUES (2, ?, 1)').run('c5142bce-64cc-4f97-8df8-6a572155582e')
    expect(() => readOrCreateConnectionIdentity(stored)).toThrow()
    expect(stored.prepare('SELECT count(*) AS count FROM controller_connection_identity').get()).toEqual({ count: 1 })
    stored.prepare('INSERT INTO controller_connection_identity VALUES (1, ?, 1)').run('e29eff63-abcc-4146-b2f8-5bb14a6f294d')
    expect(() => readOrCreateConnectionIdentity(stored)).toThrow()
  })

  it('fails closed when storage or migrations are missing', () => {
    const missing = new Database(':memory:')
    open.push(missing)
    expect(() => readOrCreateConnectionIdentity(missing)).toThrow()
    const stored = database()
    stored.pragma('query_only = ON')
    expect(() => readOrCreateConnectionIdentity(stored)).toThrow()
  })

  it('requires a fresh, bounded client challenge and a recognized schema', () => {
    const challenge = randomBytes(32).toString('base64url')
    expect(connectionChallengeSchema.parse(challenge)).toBe(challenge)
    for (const invalid of ['', 'x'.repeat(42), 'x'.repeat(44), ' '.repeat(43), '='.repeat(43)]) {
      expect(connectionChallengeSchema.safeParse(invalid).success).toBe(false)
    }
    const response = { schemaVersion: 1, controller: 'sleepypod-core', installationId: readOrCreateConnectionIdentity(database()), challenge }
    expect(connectionIdentitySchema.parse(response)).toEqual(response)
    expect(connectionIdentitySchema.safeParse({ ...response, schemaVersion: 2 }).success).toBe(false)
  })
})
