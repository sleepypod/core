import { householdIdSchema } from '../contract'
import { parseLearningSearch } from '../learningApiContract'
import { learningRemovalRequestSchema } from '../learningRemovalContract'

export function learningRemovalPath(path: string, method: string, body: unknown): boolean {
  if (method === 'POST') {
    const parsed = learningRemovalRequestSchema.safeParse(body)
    return parsed.success && path === `me/learning/records/${parsed.data.recordId}/remove`
  }
  return method === 'GET' && body === undefined && path.startsWith('me/learning/requests/')
    && householdIdSchema.safeParse(path.slice('me/learning/requests/'.length)).success
}

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
