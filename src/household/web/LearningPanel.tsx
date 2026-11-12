import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { PersonalLearningWorkspace } from './learning'
import { learningReading, learningRecordLabel } from './learningPresentation'
import type { LearningRecordDetail } from '../learningApiContract'

const savedTime = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
function downloadRecord(detail: LearningRecordDetail) {
  if (detail.payload === null) return
  const address = URL.createObjectURL(new Blob([detail.payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = address
  link.download = 'sleepypod-saved-record.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(address), 1000)
}

export function LearningPanel({ learning }: { learning: PersonalLearningWorkspace }) {
  const state = useSyncExternalStore(learning.subscribe, learning.getSnapshot)
  const reading = state.detail ? learningReading(state.detail) : null
  const readingRef = useRef<HTMLElement>(null)
  const removalRef = useRef<HTMLElement>(null)
  const removalTrigger = useRef<HTMLButtonElement>(null)
  const previousRemovalStatus = useRef(state.removalStatus)
  const recordButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (state.detail) {
      readingRef.current?.focus({ preventScroll: true })
      readingRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [state.detail])
  useEffect(() => {
    if (state.removalStatus) {
      removalRef.current?.focus({ preventScroll: true })
      removalRef.current?.scrollIntoView({ block: 'nearest' })
    }
    else if (previousRemovalStatus.current === 'review') {
      removalTrigger.current?.focus({ preventScroll: true })
      removalTrigger.current?.scrollIntoView({ block: 'nearest' })
    }
    previousRemovalStatus.current = state.removalStatus
  }, [state.removalStatus])
  return (
    <article className="learning-panel" aria-label="Your saved learning" aria-busy={state.busy}>
      <div className="row">
        <h2>Your saved learning</h2>
        {state.archives && <button type="button" onClick={() => learning.clear()}>Hide library</button>}
      </div>
      <p>History kept when you change sides stays private to your account. Browse your earlier check-ins, notes and saved models here.</p>
      {!state.available && <p className="small">This library is not enabled on your Pod yet. You can check its availability below.</p>}
      <button type="button" className="primary" disabled={state.busy} onClick={() => void learning.load()}>
        {state.busy ? state.removalStatus === 'uncertain' ? 'Waiting for removal…' : 'Reading saved learning…' : state.archives ? 'Reload library' : state.available ? 'Open my library' : 'Check library availability'}
      </button>
      {state.error && <p role="alert" className="learning-message">{state.error}</p>}
      {state.archives && (
        <>
          {state.archives.archives.length === 0
            ? (
                <section className="learning-empty">
                  <h3>No preserved library yet</h3>
                  <p>A private copy is made during a completed, reviewed side change. An empty library does not mean your current sleep recordings are missing.</p>
                </section>
              )
            : (
                <ul className="learning-list" aria-label="Saved libraries">
                  {state.archives.archives.map(archive => (
                    <li key={archive.archiveId}>
                      <div>
                        <h3>
                          Saved
                          {' '}
                          {savedTime(archive.capturedAt)}
                        </h3>
                        <p className="small">
                          {archive.recordCount.toLocaleString()}
                          {' '}
                          {archive.recordCount === 1 ? 'record' : 'records'}
                          {' · original '}
                          {' '}
                          {archive.sourceSide === 'left' ? 'Left' : 'Right'}
                          {' '}
                          arrangement
                        </p>
                      </div>
                      <button type="button" disabled={state.busy} aria-pressed={state.selected?.archiveId === archive.archiveId} onClick={() => void learning.openArchive(archive.archiveId)}>Browse saved records</button>
                    </li>
                  ))}
                </ul>
              )}
          {state.archives.nextCursor && <button type="button" disabled={state.busy} onClick={() => void learning.olderArchives()}>Show older libraries</button>}
        </>
      )}
      {state.records && (
        <section aria-label="Saved learning records">
          <h3>Records in this library</h3>
          <p className="small">Original sensor sides are retained. Saved models are historical copies; reading them does not start training or change your bed.</p>
          {state.records.records.length === 0 && <p>No records remain on this page. Reload the library to start again.</p>}
          <ul className="learning-list" aria-label="Saved records">
            {state.records.records.map(record => (
              <li key={record.recordId}>
                <div>
                  <h4>{learningRecordLabel(record)}</h4>
                  <p className="small">{record.redacted ? 'Content removed' : `Saved from ${record.sourceSide === 'left' ? 'Left' : 'Right'}`}</p>
                </div>
                <button
                  type="button"
                  disabled={state.busy}
                  aria-label={`Read ${learningRecordLabel(record)}`}
                  aria-pressed={state.detail?.recordId === record.recordId}
                  onClick={(event) => {
                    recordButton.current = event.currentTarget
                    void learning.openRecord(record.recordId)
                  }}
                >
                  Read record
                </button>
              </li>
            ))}
          </ul>
          {state.records.nextOrdinal && <button type="button" disabled={state.busy} onClick={() => void learning.olderRecords()}>Show next records</button>}
        </section>
      )}
      {state.detail && reading && (
        <section ref={readingRef} tabIndex={-1} className="learning-reading" aria-label="Selected saved record">
          <div className="row">
            <h3>{reading.title}</h3>
            <button
              type="button"
              onClick={() => {
                learning.closeRecord()
                if (recordButton.current?.isConnected) recordButton.current.focus()
              }}
            >
              Close record
            </button>
          </div>
          {state.detail.redacted
            ? <p>This record’s content was removed. Its preservation receipt remains.</p>
            : (
                <>
                  {reading.facts.length > 0 && (
                    <dl>
                      {reading.facts.map(fact => (
                        <div key={fact.label}>
                          <dt>{fact.label}</dt>
                          <dd>{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {reading.note && <p className="learning-note">{reading.note}</p>}
                  {reading.facts.length === 0 && <p>This saved file is available to download for review. Its original format is preserved.</p>}
                  <details>
                    <summary>Source and original file</summary>
                    <p className="small">
                      Saved from
                      {' '}
                      {state.detail.sourceSide === 'left' ? 'Left' : 'Right'}
                      . Ownership of a saved file does not confirm that all its training data belongs to one sleeper.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        if (state.detail) downloadRecord(state.detail)
                      }}
                    >
                      Download original record
                    </button>
                  </details>
                  {state.removalAvailable && state.removalStatus !== 'review' && (
                    <button ref={removalTrigger} type="button" disabled={state.busy} onClick={() => learning.reviewRemoval()}>Remove archived content…</button>
                  )}
                </>
              )}
        </section>
      )}
      {state.removalStatus && (
        <section ref={removalRef} tabIndex={-1} className="learning-reading" aria-label="Archived content removal">
          {state.removalStatus === 'review' && (
            <>
              <h3>Remove this archived copy?</h3>
              <p>Its content will be removed from this Pod’s saved library. A preservation receipt, including its source and date, remains.</p>
              <p className="small">Original records, active models, bed routines, existing backups and copies already saved on other devices are not deleted. This cannot be undone here.</p>
              <div className="actions">
                <button type="button" disabled={state.busy} onClick={() => learning.cancelRemoval()}>Keep this copy</button>
                <button type="button" disabled={state.busy} onClick={() => void learning.confirmRemoval()}>Remove this archived content</button>
              </div>
            </>
          )}
          {state.removalStatus === 'uncertain' && (
            <>
              <h3>{state.busy ? 'Waiting for confirmation…' : 'Check whether removal completed'}</h3>
              <p>The archived content is hidden until we can confirm the result. Checking only reads the saved receipt; it never repeats the removal request.</p>
              <button type="button" disabled={state.busy} onClick={() => void learning.checkRemoval()}>Check removal result</button>
            </>
          )}
          {state.removalStatus === 'removed' && (
            <>
              <h3>Archived content removed</h3>
              <p>The controller confirmed removal of this copy’s content. Its preservation receipt remains; original records and previously saved copies are unchanged.</p>
            </>
          )}
        </section>
      )}
    </article>
  )
}
