/**
 * Shared validation schemas for tRPC routers
 * Extracting common patterns to ensure consistency and DRY principles
 */
import { z } from 'zod'

/**
 * Time string validation (HH:MM format in 24-hour time)
 * Matches times from 00:00 to 23:59
 */
export const timeStringSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Time must be in HH:MM format (00:00-23:59)')

/**
 * Day of week enum
 */
export const dayOfWeekSchema = z.enum([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
])

/**
 * Side enum (left or right)
 */
export const sideSchema = z.enum(['left', 'right'])

/**
 * Temperature validation (55-110°F range)
 */
export const temperatureSchema = z
  .number()
  .int('Temperature must be a whole number')
  .min(55, 'Temperature must be at least 55°F')
  .max(110, 'Temperature must not exceed 110°F')

/**
 * Positive integer ID validation
 */
export const idSchema = z
  .number()
  .int('ID must be an integer')
  .positive('ID must be positive')

/**
 * Alarm vibration intensity (1-100)
 */
export const vibrationIntensitySchema = z
  .number()
  .int('Intensity must be a whole number')
  .min(1, 'Intensity must be at least 1')
  .max(100, 'Intensity must not exceed 100')

/**
 * Alarm duration in seconds (0-180s = 0-3 minutes)
 */
export const alarmDurationSchema = z
  .number()
  .int('Duration must be a whole number')
  .min(0, 'Duration must be at least 0 seconds')
  .max(180, 'Duration must not exceed 180 seconds')

/**
 * Vibration pattern enum
 */
export const vibrationPatternSchema = z.enum(['double', 'rise'])

/**
 * Temperature unit enum
 */
export const temperatureUnitSchema = z.enum(['F', 'C'])

/**
 * Tap type enum
 */
export const tapTypeSchema = z.enum(['doubleTap', 'tripleTap', 'quadTap'])

/**
 * Helper to validate time range.
 * Always returns true — onTime and offTime create independent cron jobs,
 * so midnight-crossing ranges (e.g. 22:00→06:00) are naturally supported.
 */
export function validateTimeRange(_onTime: string, _offTime: string): boolean {
  return true
}

/**
 * Helper to validate date range (startDate <= endDate)
 */
export function validateDateRange(startDate: Date, endDate: Date): boolean {
  return startDate <= endDate
}
