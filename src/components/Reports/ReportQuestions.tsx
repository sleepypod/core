import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { MorningReportQuestions } from '@/src/reports/browserQuestions'
import type { SavedMorningReport } from '@/src/reports/morning'
import { reportBlocks } from '@/src/reports/document'
import { ReportProse, reportDate } from './ReportReading'

const noSubscription = () => () => {}

/** An inline question, a readable evidence review, then an optional saved answer. */
export function ReportQuestions({ workspace, report, personal, refresh }: {
  workspace: MorningReportQuestions
  report: SavedMorningReport
  personal: boolean
  refresh: () => void
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot)
  const identity = useId()
  const region = useRef<HTMLElement>(null)
  const previousPhase = useRef(state.phase)
  const [provider, setProvider] = useState(report.provider)
  const [model, setModel] = useState(report.model)
  const [key, setKey] = useState('')
  const [server, setServer] = useState('')
  const [question, setQuestion] = useState('')
  const [consentFor, setConsentFor] = useState<string | null>(null)
  const [saveConsentFor, setSaveConsentFor] = useState<string | null>(null)
  const secure = useSyncExternalStore(noSubscription, () => window.isSecureContext, () => false)
  const consent = state.review !== null && consentFor === state.review.id
  const saveConsent = state.answer !== null && saveConsentFor === state.answer.id
  useEffect(() => {
    if (previousPhase.current === state.phase) return
    previousPhase.current = state.phase
    const section = region.current
    // Keep the user at the replaced step, without stealing focus from another task or hidden tab.
    if (section && document.visibilityState === 'visible'
      && (document.activeElement === document.body || section.contains(document.activeElement))) {
      const target = section.querySelector<HTMLElement>('[data-report-phase-heading]')
        ?? section.querySelector<HTMLElement>('h3')
      target?.focus()
    }
  }, [state.phase])
  useEffect(() => {
    const clear = () => {
      setKey('')
      setQuestion('')
      setConsentFor(null)
      setSaveConsentFor(null)
    }
    const hidden = () => {
      if (document.visibilityState !== 'visible') clear()
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', clear)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', clear)
    }
  }, [])
  const busy = ['checking', 'generating', 'saving', 'recovering'].includes(state.phase)
  const initial = ['idle', 'saved'].includes(state.phase)
  const complete = (report.followUps?.length ?? 0) >= 10
  return (
    <section ref={region} className="report-questions" aria-labelledby={`${identity}-title`} aria-busy={busy}>
      <h3 id={`${identity}-title`} tabIndex={-1}>Ask about this report</h3>
      <p className="report-muted">Use the same saved evidence to understand a finding or consider one next step.</p>
      {state.message && <p role={state.phase === 'error' || state.phase === 'uncertain' ? 'alert' : 'status'} className="report-message" tabIndex={-1} data-report-phase-heading={state.phase !== 'answer' || undefined}>{state.message}</p>}
      {state.phase === 'error' && <button type="button" onClick={refresh}>Refresh this report</button>}
      {!secure && <p>To ask here, open your trusted HTTPS Pod address. You can also ask in the iPhone app and share its updated answers.</p>}
      {complete && <p>This report has reached its ten-answer limit. Create a new report in the iPhone app for another conversation.</p>}
      {!report.facts.length && <p>This older report has no saved facts to answer questions from. Create a new report in the iPhone app.</p>}
      {secure && !complete && report.facts.length > 0 && initial && (
        <form
          className="report-question-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (provider === 'apple') return
            const prepared = workspace.prepare({ provider, model, ...(provider === 'ollama' ? { server } : {}) }, question, key)
            setKey('')
            void prepared
          }}
        >
          <label htmlFor={`${identity}-provider`}>Answer with</label>
          <select
            id={`${identity}-provider`}
            value={provider}
            onChange={(event) => {
              const next = event.target.value as SavedMorningReport['provider']
              setProvider(next)
              setModel(next === report.provider ? report.model : '')
              setKey('')
              setServer('')
            }}
          >
            <option value="apple">Apple Intelligence · iPhone app</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Your Ollama server</option>
          </select>
          {provider === 'apple'
            ? <p>Apple’s local model runs in the iPhone app. Open this saved report there to ask privately, then choose whether to share the answer. Selecting another provider here is optional.</p>
            : (
                <>
                  <label htmlFor={`${identity}-model`}>Model ID</label>
                  <input id={`${identity}-model`} value={model} maxLength={128} autoCapitalize="none" spellCheck={false} required onChange={event => setModel(event.target.value)} />
                  <p className="report-muted">Use a model available to your account or server. Your saved report’s choice is prefilled when applicable.</p>
                  {provider === 'ollama'
                    ? (
                        <>
                          <label htmlFor={`${identity}-server`}>Ollama server address</label>
                          <input id={`${identity}-server`} type="url" value={server} maxLength={2048} placeholder="https://your-model-server" required onChange={event => setServer(event.target.value)} />
                          <p className="report-muted">Use an HTTPS origin, or localhost on this device. The server must allow this browser’s origin. Its operator receives your question and facts.</p>
                        </>
                      )
                    : (
                        <>
                          <label htmlFor={`${identity}-key`}>Your provider API key</label>
                          <input id={`${identity}-key`} type="password" value={key} maxLength={4096} autoComplete="off" autoCapitalize="none" spellCheck={false} required onChange={event => setKey(event.target.value)} />
                          <p className="report-muted">Used for this request only. It is not saved in browser storage or sent to the Pod. Your provider’s charges and data policy apply.</p>
                        </>
                      )}
                  <label htmlFor={`${identity}-question`}>Your question</label>
                  <textarea id={`${identity}-question`} value={question} maxLength={600} rows={3} required placeholder="What does this report say about my sleep timing?" onChange={event => setQuestion(event.target.value)} />
                  <button type="submit" disabled={!model.trim() || !question.trim() || !(provider === 'ollama' ? server.trim() : key.trim())}>Review question</button>
                </>
              )}
        </form>
      )}
      {state.phase === 'review' && state.review && (
        <div className="report-question-review">
          <h4 tabIndex={-1} data-report-phase-heading>Review before sending</h4>
          <p className="report-question-text">{state.review.question}</p>
          <dl className="report-facts">
            <div>
              <dt>Model</dt>
              <dd>
                {state.review.choice.provider}
                {' '}
                ·
                {' '}
                {state.review.choice.model}
              </dd>
            </div>
            <div>
              <dt>Destination</dt>
              <dd>{state.review.destination}</dd>
            </div>
            <div>
              <dt>Saved evidence</dt>
              <dd>
                {reportDate(state.review.reportDate)}
                {' '}
                ·
                {' '}
                {state.review.source}
              </dd>
            </div>
          </dl>
          <details>
            <summary>
              Read the
              {' '}
              {state.review.facts.length}
              {' '}
              {state.review.facts.length === 1 ? 'fact' : 'facts'}
              {' '}
              being sent
            </summary>
            <dl className="report-facts">
              {state.review.facts.map(fact => (
                <div key={fact.id}>
                  <dt>{fact.id}</dt>
                  <dd>{fact.text}</dd>
                </div>
              ))}
            </dl>
          </details>
          <p className="report-muted">Only your question and these calculated facts are sent. This is older evidence, not a new reading. The review expires in five minutes.</p>
          <label className="report-question-check">
            <input type="checkbox" checked={consent} onChange={event => setConsentFor(event.target.checked ? state.review?.id ?? null : null)} />
            Send this question and these facts to the selected model.
          </label>
          <div className="report-question-actions">
            <button type="button" disabled={!consent} onClick={() => void workspace.send(state.review?.id ?? '', consent)}>Ask this question</button>
            <button type="button" onClick={() => workspace.cancel()}>Cancel</button>
          </div>
        </div>
      )}
      {busy && (
        <div className="report-question-actions">
          <p role="status" tabIndex={-1} data-report-phase-heading>{state.phase === 'checking' ? 'Checking this report and your account…' : state.phase === 'saving' ? 'Saving and verifying your answer…' : state.phase === 'recovering' ? 'Checking saved result… Nothing will be uploaded.' : 'Waiting for your chosen model…'}</p>
          <button type="button" onClick={() => workspace.cancel()}>Cancel request</button>
        </div>
      )}
      {state.answer && ['answer', 'uncertain', 'recovering'].includes(state.phase) && (
        <div className="report-answer">
          <h4 tabIndex={-1} data-report-phase-heading>{state.answer.question}</h4>
          <p className="report-badge">AI interpretation · not confirmed saved</p>
          <p className="report-muted">
            {state.answer.provider}
            {' '}
            ·
            {' '}
            {state.answer.model}
            {' '}
            ·
            {' '}
            {reportDate(state.answer.createdAt)}
          </p>
          <ReportProse blocks={reportBlocks(state.answer.text, report.facts)} facts={report.facts} />
          {state.phase === 'answer'
            ? (
                <>
                  <p className="report-muted">
                    {personal ? 'Save to your personal report library. Other sleepers cannot read it through their accounts; Pod administrators and backups have system-level access.' : 'People with this Pod’s owner access can read the saved answer. Pod backups may also contain it.'}
                    {' '}
                    This does not update the iPhone’s private archive automatically.
                  </p>
                  <label className="report-question-check">
                    <input type="checkbox" checked={saveConsent} onChange={event => setSaveConsentFor(event.target.checked ? state.answer?.id ?? null : null)} />
                    Save this question and answer with the report on my Pod.
                  </label>
                  <div className="report-question-actions">
                    <button type="button" disabled={!saveConsent} onClick={() => void workspace.save(saveConsent)}>Save answer to report</button>
                    <button type="button" onClick={() => workspace.cancel()}>Discard answer</button>
                  </div>
                </>
              )
            : state.phase === 'uncertain' && <button type="button" onClick={() => void workspace.recover()}>Check saved result</button>}
        </div>
      )}
    </section>
  )
}
