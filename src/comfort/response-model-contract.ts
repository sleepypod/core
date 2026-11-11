import { z } from 'zod'
import { responseModelShape } from './response-model-schema'
import { responseAuditSchema } from './response-contract'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const responseModelPreviewSchema = z.object({
  apiVersion: z.literal(1), side: z.enum(['left', 'right']), generatedAt: z.number().int().positive(),
  activationAvailable: z.literal(false), reason: z.string(),
  candidates: z.array(z.object({ targetF: z.number().min(55).max(110), reason: z.string(),
    predictions: z.array(z.object({ minutes: z.union([z.literal(15), z.literal(30)]), waterF: z.number().min(50).max(115),
      lowerF: z.number().min(50).max(115), upperF: z.number().min(50).max(115) }).strict()
      .refine(value => value.lowerF <= value.waterF && value.waterF <= value.upperF, 'The estimate must be inside its error band.')).max(2)
      .refine(values => values.length === 0 || (values.length === 2 && values[0].minutes === 15 && values[1].minutes === 30), 'Both distinct horizons are required.'),
  }).strict()).max(2),
}).strict()

export const responseModelStatusSchema = z.object({
  apiVersion: z.literal(1), side: z.enum(['left', 'right']), generatedAt: z.number().int().positive(),
  completeNights: z.number().int().nonnegative(), requiredNights: z.literal(20), datasetHash: digest,
  canTrain: z.boolean(), activationAvailable: z.literal(false), reason: z.string(),
  evidence: responseAuditSchema,
  model: responseModelShape.omit({ support: true, horizons: true }).extend({
    id: digest, current: z.boolean(),
    horizons: z.array(responseModelShape.shape.horizons.element.omit({ coefficients: true, simpleCoefficient: true })).length(2)
      .refine(values => values[0]?.minutes === 15 && values[1]?.minutes === 30, 'Both evaluation horizons are required in order.'),
  }).nullable(),
}).strict().refine(value => value.evidence.side === value.side && value.evidence.generatedAt === value.generatedAt
  && value.evidence.datasetHash === value.datasetHash && value.evidence.responseNights === value.completeNights,
'The status and evidence must describe the same read.')
  .refine(value => !value.canTrain || (value.evidence.status === 'read' && value.completeNights >= value.requiredNights),
    'Fitting requires a complete read of enough nights.')
  .refine(value => !value.model || (value.model.side === value.side && (!value.model.current || value.evidence.status === 'read')),
    'A current model requires matching side and complete evidence.')
