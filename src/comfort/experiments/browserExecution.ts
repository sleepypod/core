import { z } from 'zod'
import { experimentExecutionCancellationSchema, experimentExecutionConfirmationSchema,
  experimentExecutionRecoverySchema, experimentExecutionStatusSchema } from './execution-contract'
import { experimentBrowserScopeSchema, readExperimentEnvelope, type ExperimentBrowserScope } from './browserContract'
import type { ExperimentRecord } from './contract'
import { experimentNights } from './nights'

const statusSchema = experimentExecutionStatusSchema.extend({ scope: experimentBrowserScopeSchema })
export type BrowserExperimentExecution = z.infer<typeof statusSchema>

/** Only fixed reviewed actions pass through the owner or personal browser transport. */
export function experimentExecutionBrowserRequest(path: string, method: string, body?: unknown): boolean {
  if (/[?#]/.test(path)) return false
  const [planId, section, action, extra] = path.split('/')
  if (!z.string().uuid().safeParse(planId).success || section !== 'execution' || extra !== undefined) return false
  if (method === 'GET') return action === undefined && body === undefined
  if (method !== 'POST') return false
  if (action === 'preview') return z.object({}).strict().safeParse(body).success
  if (action === 'confirm') return experimentExecutionConfirmationSchema.safeParse(body).success
  if (action === 'cancel') return experimentExecutionCancellationSchema.safeParse(body).success
  return action === 'recover' && experimentExecutionRecoverySchema.safeParse(body).success
}

/** Bind execution receipts to the displayed account, plan and actual scheduled treatment. */
export function readBrowserExperimentExecution(input: unknown, record: ExperimentRecord,
  scope: ExperimentBrowserScope, now: number): BrowserExperimentExecution {
  const value = readExperimentEnvelope(statusSchema, input, scope, now)
  const { plan } = record, { admission, review, generatedAt } = value
  if (value.planId !== plan.id || value.planStatus !== record.status)
    throw new Error('The comparison or its execution state changed. Refresh the saved plan.')
  if (review && (review.createdAt > generatedAt || review.expiresAt <= generatedAt || review.expiresAt <= review.createdAt))
    throw new Error('The overnight control review has expired or changed.')
  if (!admission) {
    if (value.state !== 'not_admitted' || value.applications.length)
      throw new Error('The saved admission is missing.')
    return value
  }
  if (plan.version !== 2 || admission.admittedAt > generatedAt
    || admission.admittedAt >= plan.schedule.windows[0].windowStart
    || admission.endsAt !== plan.schedule.windows.at(-1)?.windowEnd)
    throw new Error('The admission no longer matches the scheduled nights.')
  const expectedState = admission.revokedAt !== null ? 'revoked' : admission.endsAt <= generatedAt ? 'ended' : 'admitted'
  if (value.state !== expectedState || ((admission.revokedAt === null) !== (admission.reason === null))
    || (admission.revokedAt !== null && (admission.revokedAt < admission.admittedAt || admission.revokedAt > generatedAt)))
    throw new Error('The saved control status could not be verified.')
  if (new Set(value.applications.map(application => application.id)).size !== value.applications.length
    || new Set(value.applications.map(application => application.side)).size !== value.applications.length)
    throw new Error('The execution history contains repeated attempts or zones.')
  const nights = experimentNights(plan)
  for (const application of value.applications) {
    const window = plan.schedule.windows.find(candidate => application.attemptedAt >= candidate.windowStart && application.attemptedAt < candidate.windowEnd)
    const night = window ? nights.find(candidate => candidate.date === window.date) : undefined
    if (!admission.sides.includes(application.side) || application.attemptedAt < admission.admittedAt
      || application.attemptedAt > generatedAt || !night || night.targetF !== application.requestedTargetF
      || (application.finishedAt !== null && (application.finishedAt < application.attemptedAt || application.finishedAt > generatedAt)))
      throw new Error('The attempt no longer matches this comparison.')
    if ((application.outcome === 'acknowledged') !== (application.acknowledgment === 'accepted_not_physically_verified')
      || (application.outcome === 'acknowledged' && application.finishedAt === null)
      || (application.outcome === 'resolved') !== (application.resolution !== null))
      throw new Error('The attempt outcome could not be verified.')
    if (application.resolution && (application.resolution.observedAt <= Math.max(application.attemptedAt, application.finishedAt ?? 0)
      || application.resolution.resolvedAt < application.resolution.observedAt || application.resolution.resolvedAt > generatedAt))
      throw new Error('The recovery observation could not be verified.')
  }
  return value
}
