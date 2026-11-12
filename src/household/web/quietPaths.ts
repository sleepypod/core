import { householdIdSchema } from '../contract'
import { quietWriteSchema } from '../quietContract'

export function personalQuietPath(path: string, method: string, body: unknown) {
  if (path === 'me/quiet') return method === 'GET' ? body === undefined : method === 'POST' && quietWriteSchema.safeParse(body).success
  return method === 'GET' && body === undefined && path.startsWith('me/quiet/requests/')
    && householdIdSchema.safeParse(path.slice('me/quiet/requests/'.length)).success
}
