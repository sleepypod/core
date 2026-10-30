import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

export const HISTORY_FIXTURE_START = Date.parse('2026-10-10T06:00:00Z') / 1000

/** Synthetic archive shared by API and browser tests, using the real offline importer. */
export function createHistoryFixture(directory: string) {
  const original = join(directory, 'legacy-history.db')
  const filename = join(directory, 'free-sleep-history.db')
  const database = new Database(original)
  try {
    database.exec(`
      CREATE TABLE vitals (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER, heart_rate REAL, hrv REAL, breathing_rate REAL);
      CREATE TABLE movement (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER, total_movement INTEGER);
      CREATE TABLE sleep_records (id INTEGER PRIMARY KEY, side TEXT, entered_bed_at INTEGER, left_bed_at INTEGER,
        sleep_period_seconds INTEGER, times_exited_bed INTEGER, present_intervals TEXT, not_present_intervals TEXT);
      CREATE TABLE unrelated_private_data (value TEXT);
      INSERT INTO unrelated_private_data VALUES ('synthetic excluded column');
    `)
    const insert = database.prepare('INSERT INTO vitals VALUES (?,?,?,?,?,?)')
    for (let index = 0; index < 55; index++) {
      insert.run(index + 1, 'left', HISTORY_FIXTURE_START + Math.floor(index / 2) * 300, index === 54 ? null : 60, 30, 14)
    }
    insert.run(56, 'right', HISTORY_FIXTURE_START, 70, null, null)
    insert.run(57, 'left', -1, 55, 32, 14)
    insert.run(58, 'unknown', HISTORY_FIXTURE_START, 80, 35, 16)
    database.prepare('INSERT INTO movement VALUES (1,?,?,?)').run('left', HISTORY_FIXTURE_START, 3)
    const start = HISTORY_FIXTURE_START
    const end = start + 8 * 3600
    database.prepare('INSERT INTO sleep_records VALUES (1,?,?,?,?,?,?,?)').run('left', start, end, 9000, 1,
      JSON.stringify([[start - 60, start + 3600], [start + 1800, start + 7200], [end - 1800, end + 60]]), '[]')
    database.prepare('INSERT INTO sleep_records VALUES (2,?,?,?,?,?,?,?)').run('right', start, end, 0, 0, '[]', 'invalid')
  }
  finally { database.close() }
  execFileSync('python3', ['-c', `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from imported_history import prepare
prepare(Path(sys.argv[2]), Path(sys.argv[3]), 'America/Los_Angeles', 1791673200000)
`, resolve('scripts/migration'), original, filename], { timeout: 15_000, maxBuffer: 65536 })
  return { original, filename }
}
