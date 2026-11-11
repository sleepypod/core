import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PersonalJournalWorkspace, PersonalJournalState } from './journal'
import { JournalContextEditor } from '@/src/components/Sleep/JournalContextEditor'
import { sourceDate } from '@/src/lib/localDates'
import { JournalPatternsPanel } from './JournalPatternsPanel'

export function JournalPanel({ journal }: { journal: PersonalJournalWorkspace }) {
  const state = useSyncExternalStore(journal.subscribe, journal.getSnapshot)
  return <JournalPanelContent key={state.page?.entries[0].date ?? 'closed'} journal={journal} state={state} />
}

function JournalPanelContent({ journal, state }: { journal: PersonalJournalWorkspace, state: PersonalJournalState }) {
  const [date, setDate] = useState(state.page?.entries[0].date ?? '')
  const [replacement, setReplacement] = useState<{ action: 'close' | 'open', date?: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const selected = state.page?.entries[0]
  const timeZone = selected?.timeZone ?? state.page?.currentTimeZone
  const draft = state.draft
  const loaded = Boolean(selected)
  useEffect(() => {
    if (loaded) heading.current?.focus({ preventScroll: true })
  }, [loaded])
  const open = (nextDate?: string) => {
    if (state.dirty || state.pending) setReplacement({ action: 'open', date: nextDate })
    else void journal.open(nextDate)
  }
  const fieldsDisabled = state.busy || Boolean(state.pending) || deleting || Boolean(replacement)
  return (
    <article className="personal-journal" aria-label="Your morning check-in" aria-busy={state.busy}>
      <div className="row">
        <h2>Your morning check-in</h2>
        {state.page && (
          <button
            type="button"
            disabled={state.busy}
            onClick={() => {
              if (state.dirty || state.pending) setReplacement({ action: 'close' })
              else journal.clear()
            }}
          >
            Close check-in
          </button>
        )}
      </div>
      <p>Remember how the night felt. Your check-in belongs to your personal account, whichever side you slept on.</p>
      {!state.page && (
        <>
          {!state.available && <p className="small">Personal check-ins are not enabled on this Pod yet.</p>}
          <button className="primary" type="button" disabled={state.busy} onClick={() => void journal.open()}>
            {state.busy ? 'Opening check-in…' : state.available ? 'Open my check-in' : 'Check availability'}
          </button>
        </>
      )}
      {state.error && <p role="alert" className="journal-message">{state.error}</p>}
      {state.message && <p role="status" className="journal-message">{state.message}</p>}
      {state.pending && (
        <button type="button" disabled={state.busy} onClick={() => void journal.reconcile()}>
          {state.busy ? 'Checking saved result…' : 'Check saved result'}
        </button>
      )}
      {state.page && selected && draft && (
        <>
          <div className="journal-date">
            <label>
              Wake date
              <input
                type="date"
                min="1970-01-01"
                max={sourceDate(state.page.generatedAt / 1000, state.page.currentTimeZone)}
                value={date}
                disabled={state.busy}
                onChange={event => setDate(event.target.value)}
              />
            </label>
            <button type="button" disabled={state.busy || !date} onClick={() => open(date)}>Open date</button>
            <button type="button" disabled={state.busy} onClick={() => open()}>Today</button>
          </div>
          {replacement && (
            <section className="journal-confirm" aria-label="Review unsaved check-in">
              <h3>Leave this draft?</h3>
              <p>
                {state.pending
                  ? 'The earlier save may have reached your Pod. Reopening reads the current entry; it never sends that save again.'
                  : `The changes in this page have not been saved. ${replacement.action === 'close' ? 'Closing' : 'Opening another entry'} will discard this draft.`}
              </p>
              <div className="actions">
                <button type="button" onClick={() => setReplacement(null)}>Keep this draft</button>
                <button
                  type="button"
                  onClick={() => {
                    const next = replacement
                    setReplacement(null)
                    if (next.action === 'close') journal.clear()
                    else void journal.open(next.date)
                  }}
                >
                  {replacement.action === 'close' ? 'Discard draft and close' : 'Discard draft and open entry'}
                </button>
              </div>
            </section>
          )}
          <h3 ref={heading} tabIndex={-1}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${selected.date}T12:00:00Z`))}</h3>
          <p className="small">
            {state.pending
              ? 'Last loaded entry — save result not yet confirmed'
              : state.dirty
                ? 'Unsaved changes to your check-in'
                : selected.record ? 'Your saved check-in' : 'No saved check-in for this morning'}
            {' '}
            ·
            {' '}
            {timeZone}
          </p>
          <form onSubmit={(event) => {
            event.preventDefault()
            void journal.save()
          }}
          >
            <fieldset className="editor-fields" disabled={fieldsDisabled}>
              <legend className="journal-form-title">How did you feel?</legend>
              <div className="journal-ratings">
                <label>
                  How rested did you feel?
                  <select required value={draft.restfulness ?? ''} onChange={event => journal.edit({ restfulness: event.target.value ? Number(event.target.value) : null })}>
                    <option value="">Choose how rested</option>
                    <option value="1">1 — Very tired</option>
                    <option value="2">2 — Somewhat tired</option>
                    <option value="3">3 — In between</option>
                    <option value="4">4 — Rested</option>
                    <option value="5">5 — Very rested</option>
                  </select>
                </label>
                <label>
                  Bed temperature comfort
                  <select required value={draft.comfort ?? ''} onChange={event => journal.edit({ comfort: event.target.value ? event.target.value as 'cold' | 'comfortable' | 'warm' : null })}>
                    <option value="">Choose your comfort</option>
                    <option value="cold">Too cold</option>
                    <option value="comfortable">Comfortable</option>
                    <option value="warm">Too warm</option>
                  </select>
                </label>
              </div>
              <label>
                Anything to remember?
                {' '}
                <span className="small">Optional</span>
                <textarea maxLength={500} value={draft.notes} onChange={event => journal.edit({ notes: event.target.value })} />
              </label>
              <p className="small">
                {draft.notes.length}
                {' '}
                / 500 characters
              </p>
              <details className="personal-journal-context">
                <summary>
                  Add habits and timing
                  {' '}
                  <span className="small">(optional)</span>
                </summary>
                <JournalContextEditor
                  draft={draft.context}
                  timeZone={timeZone ?? state.page.currentTimeZone}
                  onChange={context => journal.edit({ context })}
                />
              </details>
              <button className="primary" type="submit" disabled={fieldsDisabled || !state.dirty || draft.restfulness === null || draft.comfort === null}>
                {state.busy && state.pending?.outcome === 'saved' ? 'Saving check-in…' : 'Save my check-in'}
              </button>
            </fieldset>
          </form>
          <p className="small">Drafts stay in this open page. Save before switching apps or closing it. Check-ins describe your experience; saving one does not change the bed or train a model.</p>
          {selected.record && !deleting && <button type="button" disabled={state.busy || Boolean(state.pending) || Boolean(replacement)} onClick={() => setDeleting(true)}>Remove this check-in…</button>}
          {deleting && (
            <section className="journal-confirm" aria-label="Confirm check-in removal">
              <h3>Remove this morning’s check-in?</h3>
              <p>Its ratings, habit details and note will be removed from your current journal. Existing backups and exported copies will remain.</p>
              <div className="actions">
                <button type="button" disabled={state.busy} onClick={() => setDeleting(false)}>Keep check-in</button>
                <button
                  type="button"
                  disabled={state.busy}
                  onClick={() => {
                    setDeleting(false)
                    void journal.save(true)
                  }}
                >
                  Delete check-in
                </button>
              </div>
            </section>
          )}
          <JournalPatternsPanel journal={journal} state={state} />
        </>
      )}
    </article>
  )
}
