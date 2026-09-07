import type Database from 'better-sqlite3'
import { configSchema, editConfig, emptyConfig, type Edit, type Side } from './model'
export class RemoteConflictError extends Error {
}
export class RemoteStore {
  constructor(private sqlite: Database.Database) { }
  read() {
    const row = this.sqlite.prepare('SELECT config FROM remote_configuration WHERE id = 1').get() as {
      config: string
    } | undefined
    return row ? configSchema.parse(JSON.parse(row.config)) : emptyConfig()
  }

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
