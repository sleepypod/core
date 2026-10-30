import { z } from 'zod'
import { dataHash } from '../algorithms/canonical'
import { shadowChildBudgetsSchema } from './execution-policy'
import { shadowWorkerHealthSchema } from './worker-protocol'
import type { ShadowExecutionPolicy } from './execution-policy'
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const shadowWorkerReceiptSchema = z.object({ health: shadowWorkerHealthSchema,
  inputBytes: integer, outputBytes: integer, peakObservedRssBytes: integer.positive(), rssSamples: integer.positive(),
  maximumObservationGapMs: z.number().finite().nonnegative(), budgets: shadowChildBudgetsSchema,
  memoryScope: z.literal('sum_rss_of_shadow_process_group'), exactKernelPeak: z.literal(false),
}).strict()
export function validateShadowWorkerReceipt(raw: unknown, execution: ShadowExecutionPolicy) {
  const receipt = shadowWorkerReceiptSchema.parse(raw)
  const h = receipt.health
  if (h.state !== 'completed' || h.reason !== 'window_complete' || h.records !== h.counts.records || h.outputs > h.counts.scored_outputs
    || h.counts.accepted_frames + h.counts.empty_channel_frames + h.counts.pump_gated_frames + (h.counts.timestamp_rejected_frames ?? 0) > h.records
    || h.counts.scored_outputs + h.counts.preroll_outputs > 2 * h.counts.accepted_frames
    || h.records > execution.maximumRecords || h.outputs > execution.maximumOutputs || h.cpu_ms > execution.maximumCpuMs
    || receipt.inputBytes > execution.maximumInputBytes || receipt.outputBytes > execution.maximumOutputBytes
    || receipt.peakObservedRssBytes > execution.budgets.maximumRssBytes
    || dataHash(receipt.budgets) !== dataHash(execution.budgets)) throw new Error('Shadow worker receipt does not match execution policy')
  return receipt
}
const completedEnvelopeSchema = z.object({ schema: z.literal('biometric-shadow-receipt-v1'),
  runId: z.string().uuid(), attemptId: z.string().uuid(), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAtMs: integer, receipt: shadowWorkerReceiptSchema }).strict()

/** Supervisor observations from an incomplete attempt. Quota excess is evidence,
 * not a reason to discard the receipt. CPU/health is only the last valid reply. */
export const shadowPartialReceiptSchema = z.object({
  kind: z.literal('partial_supervisor_observation'), health: shadowWorkerHealthSchema.nullable(),
  inputBytes: integer, outputBytes: integer, diagnosticBytes: integer,
  peakObservedRssBytes: integer.positive().nullable(), rssSamples: integer,
  maximumObservationGapMs: z.number().finite().nonnegative(), budgets: shadowChildBudgetsSchema,
  cleanupConfirmed: z.boolean(), memoryScope: z.literal('sum_rss_of_shadow_process_group'), exactKernelPeak: z.literal(false),
}).strict().refine(value => (value.rssSamples === 0) === (value.peakObservedRssBytes === null), 'RSS availability mismatch')
export type ShadowPartialReceipt = z.infer<typeof shadowPartialReceiptSchema>
export function validateShadowPartialReceipt(raw: unknown, execution: ShadowExecutionPolicy) {
  const receipt = shadowPartialReceiptSchema.parse(raw)
  if (dataHash(receipt.budgets) !== dataHash(execution.budgets)) throw new Error('Shadow partial receipt policy mismatch')
  return receipt
}
export const shadowPartialEnvelopeSchema = z.object({ schema: z.literal('biometric-shadow-partial-receipt-v1'),
  runId: z.string().uuid(), attemptId: z.string().uuid(), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAtMs: integer, receipt: shadowPartialReceiptSchema }).strict()
export const shadowReceiptEnvelopeSchema = z.discriminatedUnion('schema', [completedEnvelopeSchema, shadowPartialEnvelopeSchema])
