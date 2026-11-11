import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'

export const connectionChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const connectionIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  controller: z.literal('sleepypod-core'),
  installationId: z.uuid(),
  challenge: connectionChallengeSchema,
})
const storedIdentitySchema = z.object({
  id: z.literal(1), installationId: z.uuid(), createdAt: z.number().int().positive(),
})

/** Only an absent row is initialized. Corrupt or unavailable storage must never silently change identity. */
export function readOrCreateConnectionIdentity(database: Database.Database): string {
  const read = () => {
    const rows = database.prepare('SELECT id, installation_id AS installationId, created_at AS createdAt FROM controller_connection_identity LIMIT 2').all()
    if (rows.length > 1) throw new Error('Controller connection identity metadata is invalid')
    return rows.length === 1 ? storedIdentitySchema.parse(rows[0]) : undefined
  }
  const existing = read()
  if (existing !== undefined) return storedIdentitySchema.parse(existing).installationId
  return database.transaction(() => {
    // Another process may have provisioned this installation before the write lock was acquired.
    let current = read()
    if (current === undefined) {
      database.prepare('INSERT INTO controller_connection_identity (id, installation_id, created_at) VALUES (1, ?, ?)').run(randomUUID(), Date.now())
      current = read()
    }
    return storedIdentitySchema.parse(current).installationId
  }).immediate()
}
