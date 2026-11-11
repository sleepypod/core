import { createRoot } from 'react-dom/client'
import { householdSessionSchema, type HouseholdSession } from '../contract'
import { PersonalBrowserClient } from './client'
import { BrowserRecoveryJournal } from './recovery'
import { PersonalWebWorkspace } from './workspace'
import { PersonalWorkspace } from './PersonalWorkspace'
import { PersonalHistoryWorkspace } from './history'
import { PersonalLearningWorkspace } from './learning'
import { PersonalJournalWorkspace } from './journal'
import { HouseholdMaintenanceWorkspace } from './maintenance'
import { ArrangementMaintenancePanel } from './ArrangementMaintenancePanel'
export { BrowserRecoveryJournal } from './recovery'
export { contextKey } from './protocol'
/** Mounted outside the owner application: no owner provider, transport or stream. */
export function mountPersonalWorkspace(element: HTMLElement, input: HouseholdSession, preferences: {
  preferredTemperatureF: number
  displayUnit: 'F' | 'C'
}, invalidated: () => void, lifecycle?: { maintenanceModeChanged: (mode: 'checking' | 'ordinary' | 'maintenance') => void, maintenanceFinished: () => void }) {
  const session = householdSessionSchema.parse(input)
  const root = createRoot(element)
  const supportsMaintenance = session.role === 'owner' && session.capabilities.arrangementMaintenance === true
  let mode: 'checking' | 'ordinary' | 'maintenance' = supportsMaintenance ? 'checking' : 'ordinary'
  let currentPreferences = preferences
  let disposed = false
  const invalidate = () => {
    if (disposed) return
    workspace.dispose()
    history.dispose()
    learning.dispose()
    journal.dispose()
    maintenance.dispose()
    invalidated()
  }
  const workspace = new PersonalWebWorkspace({ session, client: new PersonalBrowserClient(session), journal: new BrowserRecoveryJournal(), invalidated: invalidate })
  const history = new PersonalHistoryWorkspace({ session, client: new PersonalBrowserClient(session), invalidated: invalidate })
  const learning = new PersonalLearningWorkspace({ session, client: new PersonalBrowserClient(session), invalidated: invalidate })
  const journal = new PersonalJournalWorkspace({ session, client: new PersonalBrowserClient(session), invalidated: invalidate })
  const maintenance = new HouseholdMaintenanceWorkspace({ session, client: new PersonalBrowserClient(session), invalidated: invalidate,
    entered: () => {
      mode = 'maintenance'
      workspace.dispose()
      history.dispose()
      learning.dispose()
      journal.dispose()
      lifecycle?.maintenanceModeChanged(mode)
      render(currentPreferences)
    },
    finished: () => lifecycle?.maintenanceFinished(),
  })
  const render = (value: typeof preferences) => {
    if (disposed) return
    currentPreferences = value
    root.render(mode === 'ordinary'
      ? <PersonalWorkspace workspace={workspace} history={history} learning={learning} journal={journal} maintenance={supportsMaintenance ? maintenance : undefined} {...value} />
      : <div className="personal-runtime"><ArrangementMaintenancePanel workspace={maintenance} standalone /></div>)
  }
  const unsubscribe = maintenance.subscribe(() => {
    const state = maintenance.getSnapshot()
    // Check held transitions before mounting any controls on a restored account.
    if (mode === 'checking' && state.loaded && !state.entered && !['held', 'committed'].includes(state.status?.operation?.state ?? '')) {
      mode = 'ordinary'
      lifecycle?.maintenanceModeChanged(mode)
      render(currentPreferences)
      void workspace.start()
    }
  })
  lifecycle?.maintenanceModeChanged(mode)
  render(preferences)
  if (supportsMaintenance) void maintenance.refresh()
  else void workspace.start()
  const polling = setInterval(() => {
    if (mode === 'ordinary' && document.visibilityState === 'visible')
      void workspace.refresh()
  }, 5000)
  const freshness = setInterval(() => {
    if (mode === 'ordinary') workspace.tick()
  }, 1000)
  // Never restore a private recording page from a backgrounded account view.
  const hideHistory = () => {
    if (document.visibilityState !== 'visible') {
      history.clear()
      learning.clear()
      journal.clear()
      maintenance.clear()
    }
  }
  document.addEventListener('visibilitychange', hideHistory)
  const historyAccess = setInterval(() => {
    if (mode === 'ordinary' && document.visibilityState === 'visible') {
      void history.checkAccess()
      void learning.checkAccess()
      void journal.checkAccess()
    }
  }, 15000)
  return { updatePreferences: render, dispose() {
    if (disposed) return
    disposed = true
    clearInterval(polling)
    clearInterval(freshness)
    clearInterval(historyAccess)
    document.removeEventListener('visibilitychange', hideHistory)
    workspace.dispose()
    history.dispose()
    learning.dispose()
    journal.dispose()
    unsubscribe()
    maintenance.dispose()
    root.unmount()
  } }
}
