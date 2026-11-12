import { useEffect, useId, useSyncExternalStore } from 'react'
import type { MorningReportBrowserWorkspace } from '@/src/reports/browserWorkspace'
import { ReportReading, reportDate } from './ReportReading'
import { ReportQuestions } from './ReportQuestions'

/** Both browser account types share this renderer; their transports remain separate. */
export function ReportLibrary({ workspace, autoOpen = false, compact = false, personal = false }: {
  workspace: MorningReportBrowserWorkspace
  autoOpen?: boolean
  compact?: boolean
  personal?: boolean
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot)
  const titleID = useId(), selectID = useId()
  useEffect(() => {
    if (autoOpen) void workspace.open()
    const hide = () => {
      if (document.visibilityState !== 'visible') workspace.clear()
    }
    const clear = () => workspace.clear()
    const storage = (event: StorageEvent) => {
      if (event.key === 'sleepypod-account-change') clear()
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sleepypod-account')
    if (channel) channel.onmessage = clear
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', clear)
    window.addEventListener('storage', storage)
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void workspace.checkAccess()
    }, 15000)
    return () => {
      clearInterval(interval)
      channel?.close()
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', clear)
      window.removeEventListener('storage', storage)
      workspace.clear()
    }
  }, [workspace, autoOpen])
  return (
    <section className="morning-library" aria-labelledby={titleID} aria-busy={state.busy}>
      <div className="report-heading">
        <div>
          <h2 id={titleID}>Your morning brief</h2>
          <p className="report-muted">Reports you explicitly shared with this Pod.</p>
        </div>
        <button type="button" disabled={state.busy} onClick={() => void workspace.open(state.selectedId)}>
          {state.busy ? 'Opening reports…' : state.reports ? 'Refresh reports' : 'Open shared reports'}
        </button>
      </div>
      {state.error && <p role="alert" className="report-message">{state.error}</p>}
      {state.busy && <p role="status">Checking your account and saved report…</p>}
      {state.reports?.length === 0 && !state.withdrawn && (
        <p>
          {personal ? 'No reports have been shared with your personal account. Owner reports are kept separate.' : 'No reports have been shared with this account. In the iPhone app, open a saved morning brief, choose Web copy and review sharing.'}
          {' '}
          Nothing is uploaded automatically.
        </p>
      )}
      {state.reports && (state.reports.length > 1 || (state.withdrawn && state.reports.length > 0)) && !compact && (
        <div className="report-picker">
          <label htmlFor={selectID}>Saved report</label>
          <select id={selectID} value={state.selectedId ?? ''} onChange={event => void workspace.open(event.target.value)}>
            {state.withdrawn && <option value={state.selectedId ?? ''}>Withdrawn copy</option>}
            {state.reports.map(report => (
              <option value={report.id} key={report.id}>
                {report.createdAt === null ? 'Date unavailable' : reportDate(report.createdAt)}
                {' '}
                ·
                {' '}
                {report.source}
              </option>
            ))}
          </select>
        </div>
      )}
      {state.withdrawn && <p className="report-message">This web copy was withdrawn. The original on your device and existing backups are unchanged.</p>}
      {state.report && <ReportReading key={`reading-${state.report.id}`} report={state.report} compact={compact} />}
      {state.report && !compact && <ReportQuestions key={`questions-${state.report.id}`} workspace={workspace.questions} report={state.report} personal={personal} refresh={() => void workspace.open(state.selectedId)} />}
      {state.checkedAt !== null && (
        <p className="report-muted report-checked">
          Library checked
          {' '}
          {reportDate(state.checkedAt)}
          . Saved evidence has its own date above.
        </p>
      )}
    </section>
  )
}
