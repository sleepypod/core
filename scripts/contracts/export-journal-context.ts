import { execFileSync } from 'node:child_process'
import { journalPageSchema, type JournalSelection } from '../../src/journal/contract'
import { journalContextPatterns } from '../../src/journal/contextPatterns'
import { shiftHistoryDate } from '../../src/lib/localDates'

// Deterministic, synthetic contract evidence for independently implemented native clients.
const now = Date.parse('2026-11-01T20:00Z')
const through = '2026-11-01'
const entries: JournalSelection[] = Array.from({ length: 10 }, (_, index) => {
  const date = shiftHistoryDate(through, -index)
  const bedtimeAt = Date.parse(`${date}T06:00Z`)
  const near = index < 5
  return { side: 'left', date, revision: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, record: {
    side: 'left', date, origin: 'sleepypod', timeZone: 'America/Los_Angeles', createdAt: now, updatedAt: now, importedAt: null,
    fields: { restfulness: 4, comfort: near ? 'warm' : 'comfortable', caffeine: true, alcohol: false, exercise: true, notes: 'Synthetic habit comparison',
      context: { version: 1, bedtimeAt, stress: near ? 'higher' : 'usual',
        caffeine: { status: 'yes', unit: 'milligrams', amount: near ? 200 : 100, lastAt: bedtimeAt - (near ? 2 : 8) * 3600_000 },
        alcohol: { status: 'not_logged', unit: 'usStandardDrinks' },
        exercise: { status: 'yes', unit: 'minutes', amount: 30, lastAt: bedtimeAt - (near ? 1 : 5) * 3600_000 } } },
  } }
})
const page = journalPageSchema.parse({ apiVersion: 1, contextVersion: 1, side: 'left', timeZone: 'America/Los_Angeles', deviceDate: through,
  from: shiftHistoryDate(through, -29), through, selected: entries[0], entries,
  patterns: { recentEntries: 7, averageRestfulness: 4, warmCount: 5, coldCount: 0, cohorts: [], note: 'Synthetic journal fixture; no bed-presence recordings supplied.' },
  contextPatterns: journalContextPatterns(entries, now) })
process.stdout.write(`${JSON.stringify({ synthetic: true, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), page }, null, 2)}\n`)
