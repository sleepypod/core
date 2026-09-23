import type Database from 'better-sqlite3'
import { configSchema, editConfig, emptyConfig, type Edit, type Side } from './model'
export class RemoteConflictError extends Error {
  readonly code = 'REMOTE_MAPPING_CONFLICT'
}
/** Error constructors can differ between Next.js module graphs. */
export function isRemoteConflictError(error: unknown): error is Error {
  return error instanceof Error && 'code' in error && error.code === 'REMOTE_MAPPING_CONFLICT'
}
export class RemoteStore {
  /** Wrap the supplied SQLite connection; mapping state remains in the database. */
  constructor(private sqlite: Database.Database) { }
  /** Read and validate the persisted mapping, or return firmware inheritance when absent. */
  read() {
    const row = this.sqlite.prepare('SELECT config FROM remote_configuration WHERE id = 1').get() as {
      config: string
    } | undefined
    return row ? configSchema.parse(JSON.parse(row.config)) : emptyConfig()
  }

  /** Atomically apply an edit only when the supplied revision matches; otherwise throw a conflict. */
  edit(side: Side, revision: number, edit: Edit) {
    return this.sqlite.transaction(() => {
      const current = this.read()
      if (current.revision !== revision)
        throw new RemoteConflictError('Mapping changed elsewhere. Reload and try again.')
      const next = editConfig(current, side, edit)
      this.sqlite.prepare('INSERT INTO remote_configuration (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config').run(JSON.stringify(next))
      return next
    })()
  }
}
