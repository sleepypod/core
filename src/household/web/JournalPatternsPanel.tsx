import { useState } from 'react'
import type { PersonalJournalState, PersonalJournalWorkspace } from './journal'
import { shiftHistoryDate, sourceDate } from '@/src/lib/localDates'

/** A read-only extension of the check-in form; drafts and partner entries never enter these findings. */
export function JournalPatternsPanel({ journal, state }: { journal: PersonalJournalWorkspace, state: PersonalJournalState }) {
  const selected = state.page?.entries[0].date ?? ''
  const [from, setFrom] = useState(() => selected ? shiftHistoryDate(selected, -29) : '')
  const [through, setThrough] = useState(selected)
  const patterns = state.patterns
  const busy = state.busy || state.patternsBusy || Boolean(state.pending)
  if (!state.page || !state.patternsAvailable) return null
  const maximum = sourceDate(state.page.generatedAt / 1000, state.page.currentTimeZone)
  return (
    <details className="journal-patterns" onToggle={(event) => { if (!event.currentTarget.open) journal.clearPatterns() }}>
      <summary>Habits and feeling too warm</summary>
      <p>Compare your saved check-ins. Each difference needs five usable dates in both groups. Only your personal journal is included; unsaved changes are not.</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        void journal.loadPatterns(from, through)
      }}
      >
        <div className="journal-pattern-dates">
          <label>
            Compare from
            <input
              type="date"
              min="1970-01-01"
              max={maximum}
              value={from}
              disabled={busy}
              required
              onChange={(event) => {
                setFrom(event.target.value)
                journal.clearPatterns()
              }}
            />
          </label>
          <label>
            Compare through
            <input
              type="date"
              min={from || '1970-01-01'}
              max={maximum}
              value={through}
              disabled={busy}
              required
              onChange={(event) => {
                setThrough(event.target.value)
                journal.clearPatterns()
              }}
            />
          </label>
        </div>
        <button type="submit" disabled={busy || !from || !through}>{state.patternsBusy ? 'Comparing saved check-ins…' : 'Compare saved check-ins'}</button>
      </form>
      {state.patternsError && <p role="alert" className="journal-message">{state.patternsError}</p>}
      {patterns && (
        <section aria-label="Your habit comparisons" aria-live="polite">
          <p className="small">
            Saved check-ins from
            {' '}
            {patterns.query.from}
            {' '}
            through
            {' '}
            {patterns.query.through}
            . Read
            {' '}
            {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(patterns.generatedAt))}
            .
          </p>
          {!patterns.cohorts.length && <p>No saved check-ins in this range. Add a little optional context to a morning check-in to begin.</p>}
          {patterns.cohorts.map(cohort => (
            <section key={cohort.timeZone} className="journal-pattern-cohort" aria-label={`Comparisons in ${cohort.timeZone}`}>
              <h4>
                {cohort.dates}
                {' '}
                saved dates ·
                {' '}
                {cohort.timeZone}
              </h4>
              {cohort.comparisons.map((item) => {
                const difference = item.warmRateDifferencePoints
                if (difference === null) return null
                return (
                  <div key={item.id} className="journal-pattern-finding">
                    <h5>{item.label}</h5>
                    <p>
                      {item.withLabel}
                      : too warm on
                      {' '}
                      {item.withWarmCount}
                      {' '}
                      of
                      {' '}
                      {item.withCount}
                      {' '}
                      dates.
                      {' '}
                      {item.withoutLabel}
                      : too warm on
                      {' '}
                      {item.withoutWarmCount}
                      {' '}
                      of
                      {' '}
                      {item.withoutCount}
                      {' '}
                      dates.
                    </p>
                    <p className="small">
                      {item.excludedCount}
                      {' '}
                      entries excluded ·
                      {' '}
                      {difference === 0
                        ? 'No difference at this precision (0 percentage points)'
                        : `${Math.abs(difference)} percentage points ${difference < 0 ? 'lower' : 'higher'} in the first group`}
                      . Association only.
                    </p>
                  </div>
                )
              })}
              {!cohort.comparisons.some(item => item.warmRateDifferencePoints !== null) && <p>No comparison has enough usable dates yet.</p>}
              <details>
                <summary>Comparison definitions and counts</summary>
                <dl>
                  {cohort.comparisons.map(item => (
                    <div key={item.id}>
                      <dt>{item.label}</dt>
                      <dd>
                        {item.withLabel}
                        :
                        {' '}
                        {item.withCount}
                        {' '}
                        ·
                        {' '}
                        {item.withoutLabel}
                        :
                        {' '}
                        {item.withoutCount}
                        {' '}
                        · Excluded:
                        {' '}
                        {item.excludedCount}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </section>
          ))}
          <p className="small">{patterns.note}</p>
        </section>
      )}
    </details>
  )
}
