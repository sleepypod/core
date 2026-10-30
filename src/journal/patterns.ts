import type { JournalPresence } from './presence'
import type { JournalCohort, JournalPage, JournalSelection } from './contract'

/** These are associations in bed presence, never sleep duration or causal recommendations. */
export function journalPatterns(entries: JournalSelection[], sources: Array<{ source: JournalCohort['source'], presence: JournalPresence }>): JournalPage['patterns'] {
  const records = entries.flatMap(entry => entry.record ? [entry.record] : [])
  const recent = records.slice(0, 7)
  const cohorts = sources.map(({ source, presence }): JournalCohort => {
    const matched = records.flatMap((record) => {
      const minutes = presence.minutes.get(record.date)
      return presence.status === 'ready' && record.timeZone === presence.timeZone && minutes !== undefined ? [{ record, minutes }] : []
    })
    const associations: JournalCohort['associations'] = []
    for (const habit of ['caffeine', 'alcohol', 'exercise'] as const) {
      const withHabit = matched.filter(item => item.record.fields[habit])
      const withoutHabit = matched.filter(item => !item.record.fields[habit])
      if (withHabit.length < 5 || withoutHabit.length < 5) continue
      const average = (group: typeof matched) => group.reduce((sum, item) => sum + item.minutes, 0) / group.length
      associations.push({ habit, withCount: withHabit.length, withoutCount: withoutHabit.length,
        presenceDifferenceMinutes: Math.round(average(withHabit) - average(withoutHabit)) })
    }
    return { source, timeZone: presence.timeZone, status: presence.status, matchedDates: matched.length,
      excludedDates: records.length - matched.length, associations }
  })
  return {
    recentEntries: recent.length,
    averageRestfulness: recent.length ? Math.round(recent.reduce((total, record) => total + record.fields.restfulness, 0) / recent.length * 10) / 10 : null,
    warmCount: recent.filter(record => record.fields.comfort === 'warm').length,
    coldCount: recent.filter(record => record.fields.comfort === 'cold').length,
    cohorts,
    note: 'Each comparison needs five distinct dates with and five without the habit in one source and time zone. Missing or malformed presence is excluded. Bed presence is not sleep duration; these associations do not establish cause. Imported records remain unqualified. Notes are not used in these calculations.',
  }
}
