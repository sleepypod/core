import { createRoot } from 'react-dom/client'
import { householdSessionSchema, type HouseholdSession } from '../contract'
import { PersonalBrowserClient } from './client'
import { BrowserRecoveryJournal } from './recovery'
import { PersonalWebWorkspace } from './workspace'
import { PersonalWorkspace } from './PersonalWorkspace'
export { BrowserRecoveryJournal } from './recovery'
export { contextKey } from './protocol'
/** Mounted outside the owner application: no owner provider, transport or stream. */
export function mountPersonalWorkspace(element: HTMLElement, input: HouseholdSession, preferences: {
  preferredTemperatureF: number
  displayUnit: 'F' | 'C'
}, invalidated: () => void) {
  const session = householdSessionSchema.parse(input)
  const root = createRoot(element)
  const workspace = new PersonalWebWorkspace({ session, client: new PersonalBrowserClient(session), journal: new BrowserRecoveryJournal(), invalidated })
  const render = (value: typeof preferences) => root.render(<PersonalWorkspace workspace={workspace} {...value} />)
  render(preferences)
  void workspace.start()
  const polling = setInterval(() => {
    if (document.visibilityState === 'visible')
      void workspace.refresh()
  }, 5000)
  const freshness = setInterval(() => workspace.tick(), 1000)
  return { updatePreferences: render, dispose() {
    clearInterval(polling)
    clearInterval(freshness)
    workspace.dispose()
    root.unmount()
  } }
}
