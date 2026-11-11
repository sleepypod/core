import { householdIdSchema } from '../contract'
import { parseLearningSearch } from '../learningApiContract'

/** Only validated reads can use the larger single-record response budget. */
export function learningReadPath(path: string, method: string, body: unknown): 'page' | 'detail' | null {
  if (method !== 'GET' || body !== undefined || path.includes('#')) return null
  const [pathname, search, extra] = path.split('?')
  if (extra !== undefined) return null
  try {
    if (pathname === 'me/learning/archives' || pathname === 'me/learning/records') {
      parseLearningSearch(new URLSearchParams(search), pathname.endsWith('/records'))
      return 'page'
    }
    if (pathname.startsWith('me/learning/records/') && search === undefined) {
      householdIdSchema.parse(pathname.slice('me/learning/records/'.length))
      return 'detail'
    }
  }
  catch { /* Invalid selectors never reach the network. */ }
  return null
}
