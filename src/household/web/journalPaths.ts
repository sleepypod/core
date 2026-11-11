import { householdIdSchema } from '../contract'
import { parsePersonalJournalQuery, personalJournalWriteSchema } from '../personalJournalContract'
import { parsePersonalJournalPatternsQuery } from '../personalJournalPatterns'

/** A personal check-in never accepts an account, mattress side or arbitrary destination. */
export function personalJournalPath(path: string, method: string, body: unknown): boolean {
  if (path.includes('#')) return false
  const [pathname, search, extra] = path.split('?')
  if (extra !== undefined) return false
  try {
    if (method === 'POST' && pathname === 'me/journal' && search === undefined) {
      personalJournalWriteSchema.parse(body)
      return true
    }
    if (method !== 'GET' || body !== undefined) return false
    if (pathname === 'me/journal/patterns' && search) {
      parsePersonalJournalPatternsQuery(new URLSearchParams(search))
      return true
    }
    if (pathname === 'me/journal' && search) {
      parsePersonalJournalQuery(new URLSearchParams(search))
      return true
    }
    if (pathname.startsWith('me/journal/requests/') && search === undefined) {
      householdIdSchema.parse(pathname.slice('me/journal/requests/'.length))
      return true
    }
  }
  catch { /* Invalid requests stay on this device. */ }
  return false
}
