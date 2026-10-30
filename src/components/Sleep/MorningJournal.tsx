'use client'

import { useState, type ReactNode } from 'react'
import { Button, PageHeader, SegmentedControl } from '@/src/components/ds'
import { useQueryClient } from '@tanstack/react-query'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from '@/src/utils/trpc'
import type { Side } from '@/src/hardware/types'
import type { JournalFields, JournalPage, JournalSelection } from '@/src/journal/contract'

const fieldClass = 'w-full rounded-ctl border border-line bg-surface px-3 py-2 text-sm text-fg'
const emptyFields: JournalFields = { restfulness: 3, comfort: 'comfortable', caffeine: false, alcohol: false, exercise: false, notes: '' }
interface Draft { fields: JournalFields, expectedRevision: string | null }
const entryKey = (side: Side, date: string) => `${side}:${date}`

export function MorningJournal({ sectionSwitch }: { sectionSwitch?: ReactNode }) {
  const [side, setSide] = useState<Side>('left')
  const [date, setDate] = useState<string>()
  const [days, setDays] = useState(30)
  const [drafts, setDrafts] = useState<Record<string, Draft | undefined>>({})
  const [messages, setMessages] = useState<Record<string, string | undefined>>({})
  const [deleteKey, setDeleteKey] = useState<{ key: string, revision: string | null }>()
  const utils = trpc.useUtils()
  const queryClient = useQueryClient()
  const query = trpc.journal.get.useQuery({ side, date, days }, { retry: false })
  const mutation = trpc.journal.save.useMutation({
    onSuccess: (result) => {
      const key = entryKey(result.side, result.date)
      setDrafts(current => ({ ...current, [key]: undefined }))
      setMessages(current => ({ ...current, [key]: result.record ? 'Check-in saved on your Pod.' : 'Check-in removed. Existing backups are unchanged.' }))
      setDeleteKey(undefined)
      // Update the selected record immediately; a failed refresh must not show the previous notes.
      queryClient.setQueriesData<JournalPage>({ queryKey: getQueryKey(trpc.journal.get) }, current => current && current.side === result.side && current.selected.date === result.date ? { ...current, selected: result } : current)
      void utils.journal.get.invalidate()
      void utils.comfort.get.invalidate()
    },
    onError: (error, input) => setMessages(current => ({ ...current, [entryKey(input.side, input.date)]: `Save not confirmed. ${error.message}` })),
  })
  const data = query.data
  const selected = data?.selected
  const key = selected ? entryKey(selected.side, selected.date) : ''
  const draft = drafts[key]
  const fields = draft?.fields ?? selected?.record?.fields ?? emptyFields
  const conflict = Boolean(draft && selected && draft.expectedRevision !== selected.revision)
  const update = (next: Partial<JournalFields>) => {
    if (!selected) return
    setDrafts(current => ({ ...current, [key]: { fields: { ...fields, ...next }, expectedRevision: draft ? draft.expectedRevision : selected.revision } }))
    setMessages(current => ({ ...current, [key]: undefined }))
    setDeleteKey(undefined)
  }
  const save = (remove = false) => {
    if (!selected) return
    mutation.mutate({ side: selected.side, date: selected.date,
      expectedRevision: remove && deleteKey ? deleteKey.revision : draft ? draft.expectedRevision : selected.revision, fields: remove ? null : fields })
  }
  const resolveConflict = (keepDraft: boolean) => {
    if (!selected) return
    setDrafts(current => ({ ...current, [key]: keepDraft ? { fields, expectedRevision: selected.revision } : undefined }))
    setMessages(current => ({ ...current, [key]: keepDraft ? 'Draft kept. Save when ready.' : 'Saved entry loaded.' }))
    setDeleteKey(undefined)
  }

  return (
    <>
      <PageHeader title="Morning journal" />
      {sectionSwitch}
      <div className="flex flex-wrap items-end gap-4">
        <SegmentedControl
          ariaLabel="Journal side"
          value={side}
          onChange={(value) => {
            setSide(value)
            setDeleteKey(undefined)
          }}
          options={[{ value: 'left', label: 'Left side' }, { value: 'right', label: 'Right side' }]}
        />
        <label className="min-w-0 text-sm text-fg-2">
          Wake date
          <input
            type="date"
            className={`${fieldClass} mt-1`}
            min="1970-01-01"
            max={data?.deviceDate}
            value={date ?? data?.through ?? ''}
            onChange={(event) => {
              if (event.target.value) {
                setDate(event.target.value)
                setDeleteKey(undefined)
              }
            }}
          />
        </label>
        <Button
          variant="ghost"
          onClick={() => {
            setDate(undefined)
            setDeleteKey(undefined)
          }}
        >
          Today
        </Button>
      </div>
      <p className="text-sm text-fg-2">
        A private check-in for the morning you woke up. Dates use the Pod’s time zone
        {data ? ` (${data.timeZone})` : ''}
        . Drafts stay in this open page; save before closing it.
      </p>
      {query.isLoading && <p role="status">Reading your journal…</p>}
      {query.error && (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>{query.error.message}</p>
          <p>Existing drafts are retained. Refresh before saving.</p>
          <Button onClick={() => void query.refetch()}>Refresh saved entry</Button>
        </div>
      )}
      {selected && (
        <section aria-label="Morning check-in" className="space-y-5 rounded-card border border-line bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-medium">How did you feel?</h2>
            <span className="text-sm text-fg-2">
              {selected.date}
              {' '}
              ·
              {' '}
              {side === 'left' ? 'Left' : 'Right'}
              {' '}
              side
            </span>
          </div>
          {selected.record?.origin === 'free-sleep' && (
            <p className="text-sm text-fg-2">
              Imported from Free Sleep ·
              {selected.record.timeZone}
              . Original creation time was not recorded.
            </p>
          )}
          {selected.record && selected.record.timeZone !== data?.timeZone && <p className="text-sm text-fg-2">This entry retains its original time zone. Comparisons exclude recordings with a different date zone.</p>}
          <fieldset disabled={mutation.isPending || Boolean(query.error)} className="space-y-5 disabled:opacity-60">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span>Restfulness</span>
                <select aria-label="Restfulness" className={fieldClass} value={fields.restfulness} onChange={event => update({ restfulness: Number(event.target.value) })}>
                  {['Very low', 'Low', 'Okay', 'Good', 'Great'].map((label, index) => (
                    <option key={label} value={index + 1}>
                      {index + 1}
                      {' '}
                      ·
                      {' '}
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-2 text-sm">
                <span>Temperature comfort</span>
                <select aria-label="Temperature comfort" className={fieldClass} value={fields.comfort} onChange={event => update({ comfort: event.target.value as JournalFields['comfort'] })}>
                  <option value="cold">Too cold</option>
                  <option value="comfortable">Comfortable</option>
                  <option value="warm">Too warm</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {(['caffeine', 'alcohol', 'exercise'] as const).map(habit => (
                <label className="flex items-center gap-2 text-sm" key={habit}>
                  <input type="checkbox" checked={fields[habit]} onChange={event => update({ [habit]: event.target.checked })} />
                  <span className="capitalize">{habit}</span>
                  <span className="sr-only">during the previous day</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-fg-2">Habits describe the day before this morning.</p>
            <label className="block space-y-2 text-sm">
              <span>Private notes</span>
              <textarea aria-label="Private notes" className={`${fieldClass} min-h-28 resize-y`} maxLength={500} value={fields.notes} onChange={event => update({ notes: event.target.value })} />
              <span className="block text-xs text-fg-2">
                {fields.notes.length}
                /500 · Saved on your Pod. Notes are not sent to AI or used in habit calculations.
              </span>
            </label>
          </fieldset>
          {conflict && (
            <div role="alert" className="space-y-3 rounded-ctl border border-line p-4 text-sm">
              <p>The saved entry changed. Your draft has been kept. Compare both before saving again.</p>
              <SavedEntry entry={selected} />
              <div className="flex flex-wrap gap-2">
                <Button disabled={mutation.isPending || Boolean(query.error)} onClick={() => resolveConflict(false)}>Use saved entry</Button>
                <Button disabled={mutation.isPending || Boolean(query.error)} onClick={() => resolveConflict(true)}>Keep my draft for this revision</Button>
              </div>
            </div>
          )}
          {messages[key] && <p role="status" className="text-sm text-fg-2">{messages[key]}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={mutation.isPending || Boolean(query.error) || conflict} onClick={() => save()}>Save check-in</Button>
            <Button variant="ghost" disabled={mutation.isPending} onClick={() => void query.refetch()}>Refresh saved entry</Button>
            {selected.record && <Button variant="ghost" disabled={mutation.isPending || Boolean(query.error) || conflict} onClick={() => setDeleteKey({ key, revision: selected.revision })}>Remove check-in</Button>}
          </div>
          {deleteKey?.key === key && (
            <div className="space-y-3 rounded-ctl border border-line p-4 text-sm" role="alert">
              <p>Remove this saved check-in and its pending comfort feedback? Learning already applied and previous backups will remain.</p>
              {deleteKey.revision !== selected.revision && <p>The saved entry changed after removal was requested. Cancel and review it first.</p>}
              <Button disabled={mutation.isPending || conflict || Boolean(query.error) || deleteKey.revision !== selected.revision} onClick={() => save(true)}>Confirm removal</Button>
              <Button variant="ghost" onClick={() => setDeleteKey(undefined)}>Cancel</Button>
            </div>
          )}
        </section>
      )}
      {data && <JournalPatterns data={data} days={days} setDays={setDays} selectDate={setDate} />}
    </>
  )
}

function SavedEntry({ entry }: { entry: JournalSelection }) {
  const fields = entry.record?.fields
  return (
    <details>
      <summary className="cursor-pointer">Compare saved entry</summary>
      {fields
        ? (
            <div className="mt-2 space-y-2 text-fg-2">
              <p>{`Restfulness ${fields.restfulness}/5 · ${fields.comfort}`}</p>
              <p>{`Caffeine: ${fields.caffeine ? 'yes' : 'no'} · Alcohol: ${fields.alcohol ? 'yes' : 'no'} · Exercise: ${fields.exercise ? 'yes' : 'no'}`}</p>
              <p className="whitespace-pre-wrap break-words">{fields.notes || 'No notes.'}</p>
            </div>
          )
        : <p className="mt-2">No saved entry for this date.</p>}
    </details>
  )
}

function JournalPatterns({ data, days, setDays, selectDate }: { data: JournalPage, days: number, setDays(value: number): void, selectDate(value: string): void }) {
  return (
    <section aria-label="Journal patterns" className="space-y-4 rounded-card border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Patterns in your check-ins</h2>
        <label className="text-sm">
          Look back
          <select aria-label="Journal range" className={`${fieldClass} mt-1`} value={days} onChange={event => setDays(Number(event.target.value))}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>
      <p className="text-sm text-fg-2">{`${data.from} to ${data.through} · ${data.entries.length} ${data.entries.length === 1 ? 'check-in' : 'check-ins'}`}</p>
      {data.patterns.recentEntries > 0
        ? (
            <p className="text-sm">{`Last ${data.patterns.recentEntries} ${data.patterns.recentEntries === 1 ? 'check-in' : 'check-ins'} in this range: restfulness ${data.patterns.averageRestfulness}/5 · ${data.patterns.warmCount} too warm · ${data.patterns.coldCount} too cold.`}</p>
          )
        : <p className="text-sm text-fg-2">No check-ins in this range yet.</p>}
      {data.patterns.cohorts.map(cohort => (
        <div key={cohort.source} className="space-y-2 border-t border-line pt-4 text-sm">
          <h3 className="font-medium">{cohort.source === 'free-sleep' ? 'Imported Free Sleep presence' : 'Core bed-presence recordings'}</h3>
          <p className="text-fg-2">
            {cohort.status === 'ready' ? `${cohort.matchedDates} matched dates · ${cohort.excludedDates} dates without matching usable presence` : cohort.status === 'not_imported' ? 'No Free Sleep history imported.' : cohort.status === 'too_many_records' ? 'This range exceeds the analysis limit. Choose a shorter range.' : 'Presence recordings are unavailable.'}
            {cohort.timeZone ? ` · ${cohort.timeZone}` : ''}
          </p>
          {cohort.associations.map(association => (
            <p key={association.habit}>{`Dates with ${association.habit} had ${Math.abs(association.presenceDifferenceMinutes)} minutes ${association.presenceDifferenceMinutes < 0 ? 'less' : 'more'} bed presence on average (${association.withCount} with, ${association.withoutCount} without).`}</p>
          ))}
          {cohort.status === 'ready' && !cohort.associations.length && <p className="text-fg-2">Not enough matched dates for a habit comparison.</p>}
        </div>
      ))}
      <p className="text-xs leading-relaxed text-fg-2">{data.patterns.note}</p>
      {data.entries.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">Saved dates in this range</summary>
          <div className="mt-3 flex flex-wrap gap-2">{data.entries.map(entry => <Button variant="ghost" key={entry.date} onClick={() => selectDate(entry.date)}>{entry.date}</Button>)}</div>
        </details>
      )}
    </section>
  )
}
