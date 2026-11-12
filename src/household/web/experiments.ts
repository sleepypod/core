import { householdSessionSchema, type HouseholdSession } from '../contract'
import type { PersonalWebTransport } from './client'
import { ComfortExperimentBrowserWorkspace } from '@/src/comfort/experiments/browserWorkspace'
import { experimentBrowserRequest } from '@/src/comfort/experiments/browserContract'

export function personalExperimentPath(path: string, method: string, body: unknown) {
  const prefix = 'me/comfort-experiments'
  if (!path.startsWith(prefix)) return false
  const suffix = path.slice(prefix.length)
  if (suffix && !suffix.startsWith('/') && !suffix.startsWith('?')) return false
  return experimentBrowserRequest(suffix.startsWith('/') ? suffix.slice(1) : suffix, method, body)
}

export function personalExperimentWorkspace(session: HouseholdSession, client: PersonalWebTransport) {
  const scope = (value: HouseholdSession) => ({ kind: 'personal' as const, podId: value.podId, householdId: value.householdId,
    accountId: value.accountId, sleeperId: value.selfSleeperId, sessionRevision: value.sessionRevision,
    assignmentRevision: value.assignmentRevision, householdRevision: value.householdRevision })
  const expected = JSON.stringify(scope(session))
  return new ComfortExperimentBrowserWorkspace({
    async access(signal) {
      if (signal.aborted) throw new Error('Experiment request interrupted.')
      const current = householdSessionSchema.parse(await client.read('household/session'))
      if (signal.aborted || !current.capabilities.comfortExperiments || JSON.stringify(scope(current)) !== expected)
        throw new Error('Personal experiment account changed.')
      return { scope: scope(current), revision: expected }
    },
    async request(path, method, body, signal) {
      const destination = `me/comfort-experiments${path.startsWith('?') || !path ? path : `/${path}`}`
      if (signal.aborted || !personalExperimentPath(destination, method, body)) throw new Error('Invalid experiment request.')
      const response = await client.read(destination, method, body)
      if (signal.aborted) throw new Error('Experiment request interrupted.')
      return response
    },
  })
}
