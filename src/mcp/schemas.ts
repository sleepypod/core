/**
 * Shared Zod shapes for MCP tool inputs. Descriptions are written for a
 * model, not for Swagger: say what the field means and what unit it is in.
 */
import { z } from 'zod'
import {
  alarmDurationSchema,
  dayOfWeekSchema,
  sideSchema,
  timeStringSchema,
  vibrationIntensitySchema,
  vibrationPatternSchema,
} from '@/src/server/validation-schemas'

export const side = sideSchema.describe('Which side of the bed: "left" or "right".')

export const optionalSide = sideSchema.optional().describe('Which side of the bed. Omit for both sides.')

export const unit = z.enum(['F', 'C']).optional().describe(
  'Temperature unit for the request. Omit to use the unit configured in device settings.',
)

/**
 * Temperatures arrive in the caller's unit and are converted to the °F
 * setpoint the hardware takes (55-110°F). Bounds are checked after conversion
 * by the router, so the raw number is only loosely typed here.
 */
export const temperature = z.number().describe(
  'Target bed temperature in the requested unit. Hardware range is 55-110°F (13-43°C).',
)

export const timeOfDay = timeStringSchema.describe('Local time in 24-hour HH:MM, e.g. "22:30".')

export const dayOfWeek = dayOfWeekSchema.describe('Day of week, lowercase, e.g. "monday".')

export const vibrationIntensity = vibrationIntensitySchema.describe('Vibration strength 1-100.')

export const vibrationPattern = vibrationPatternSchema.describe(
  '"rise" ramps up gently (default for waking); "double" is an abrupt double pulse.',
)

export const alarmDuration = alarmDurationSchema.describe('How long to vibrate, in seconds (0-180).')

export const days = z.number().int().min(1).max(90).optional().describe('How many days back to look.')

export const isoDate = z.string()
  .refine(v => !Number.isNaN(Date.parse(v)), 'Must be an ISO 8601 date or datetime')
  .optional()
  .describe('ISO 8601 date or datetime, e.g. "2026-09-28".')
