import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

it('migrates existing personal models into the library without changing activation', () => {
  const raw = new Database(':memory:')
  try {
    raw.exec(readFileSync('src/db/migrations/0030_side_stage_models.sql', 'utf8'))
    raw.exec(readFileSync('src/db/migrations/0031_side_stage_models_active.sql', 'utf8'))
    raw.prepare('INSERT INTO side_stage_models VALUES (?, ?, ?, ?, ?)').run('left', '{"version":"existing"}', 'existing', 1234, 1)
    raw.exec(readFileSync('src/db/migrations/0032_curious_robin_chapel.sql', 'utf8'))
    expect(raw.prepare('SELECT side, model, version, uploaded_at FROM stage_model_library').get()).toEqual({ side: 'left', model: '{"version":"existing"}', version: 'existing', uploaded_at: 1234 })
    expect(raw.prepare('SELECT active FROM side_stage_models').get()).toEqual({ active: 1 })
  }
  finally { raw.close() }
})
