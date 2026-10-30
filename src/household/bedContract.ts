import { z } from 'zod'
import { householdSideSchema } from './contract'
import { personalControlScopeSchema } from './controlContract'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
const temperature = z.number().finite().min(32).max(140).nullable()
export const personalBedSchema = z.object({
  version: z.literal(1), scope: personalControlScopeSchema,
  arrangement: z.enum(['solo-anywhere', 'assigned']),
  availability: z.enum(['ready', 'unassigned', 'configuration_changed', 'runtime_disabled']),
  routing: z.object({
    temperature: z.array(householdSideSchema).max(2),
    power: z.array(householdSideSchema).max(2),
    vibrationCancellation: z.array(householdSideSchema).max(2),
    // A thermal follower is not an additional scheduled vibration target.
    scheduledVibration: z.array(householdSideSchema).max(1),
    routines: householdSideSchema.nullable(),
  }).strict(),
  observation: z.object({
    state: z.enum(['fresh', 'unavailable']), observedAt: instant.nullable(),
    water: z.enum(['ok', 'low', 'unknown']), priming: z.boolean().nullable(),
  }).strict(),
  zones: z.array(z.object({
    side: householdSideSchema,
    measuredTemperatureF: temperature,
    reportedTargetF: temperature,
    reportedPowered: z.boolean().nullable(),
    requestedTargetF: z.number().finite().min(55).max(110).nullable(),
  }).strict()).max(2),
  physicalVerification: z.literal('unverified'),
}).strict()
export type PersonalBed = z.infer<typeof personalBedSchema>
