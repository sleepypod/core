/**
 * Shared validation schemas for tRPC routers
 * Extracting common patterns to ensure consistency and DRY principles
 */
import { z } from 'zod'
import type { Condition as AutomationCondition, Expr as AutomationExpr } from '@/src/automation/types'

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
 * ISO 8601 datetime string validation
 */
export const isoDatetimeSchema = z
  .string()
  .datetime({ offset: true, message: 'Must be a valid ISO 8601 datetime string' })

/**
 * Helper to validate date range (startDate <= endDate)
 */
export function validateDateRange(startDate: Date, endDate: Date): boolean {
  return startDate <= endDate
}

// ============================================================================
// Autopilot — automation rule AST (WHEN / IF / THEN)
//
// These validate the JSON stored in the automations table against the
// hand-authored AST types in src/automation/types.ts (the engine's source of
// truth). z.lazy + z.union models the recursive expression/condition trees.
// ============================================================================

/** Dotted signal identifier, e.g. `ambient.temperature`, `left.movement`. */
export const signalKeySchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/i, 'Signal must be a dotted identifier')

export const windowFnSchema = z.enum(['avg', 'min', 'max', 'sum', 'count'])
export const compareOpSchema = z.enum(['>', '>=', '<', '<=', '==', '!='])
export const binaryOpSchema = z.enum(['+', '-', '*', '/'])

/** Expression AST — operands and action params. Recursive via z.lazy. */
export const automationExprSchema: z.ZodType<AutomationExpr> = z.lazy(() => z.union([
  z.object({ kind: z.literal('literal'), value: z.number() }).strict(),
  z.object({ kind: z.literal('signal'), signal: signalKeySchema }).strict(),
  z.object({
    kind: z.literal('window'),
    fn: windowFnSchema,
    signal: signalKeySchema,
    lastMin: z.number().int().min(1).max(1440),
  }).strict(),
  z.object({
    kind: z.literal('binary'),
    op: binaryOpSchema,
    left: automationExprSchema,
    right: automationExprSchema,
  }).strict(),
  z.object({
    kind: z.literal('clamp'),
    value: automationExprSchema,
    min: automationExprSchema,
    max: automationExprSchema,
  }).strict(),
]))

/** Condition AST — AND/OR/NOT tree over comparisons. Recursive via z.lazy. */
export const automationConditionSchema: z.ZodType<AutomationCondition> = z.lazy(() => z.union([
  z.object({ kind: z.literal('and'), conditions: z.array(automationConditionSchema).max(24) }).strict(),
  z.object({ kind: z.literal('or'), conditions: z.array(automationConditionSchema).max(24) }).strict(),
  z.object({ kind: z.literal('not'), condition: automationConditionSchema }).strict(),
  z.object({
    kind: z.literal('compare'),
    op: compareOpSchema,
    left: automationExprSchema,
    right: automationExprSchema,
  }).strict(),
  z.object({
    kind: z.literal('between'),
    subject: automationExprSchema,
    min: automationExprSchema,
    max: automationExprSchema,
  }).strict(),
  z.object({ kind: z.literal('timeBetween'), start: timeStringSchema, end: timeStringSchema }).strict(),
  z.object({ kind: z.literal('onDays'), days: z.array(dayOfWeekSchema).min(1) }).strict(),
]))

/** Trigger (WHEN). */
export const automationTriggerSchema = z.union([
  z.object({ kind: z.literal('tick'), everyMin: z.number().int().min(1).max(1440) }).strict(),
  z.object({ kind: z.literal('signalChange'), signal: signalKeySchema }).strict(),
  z.object({
    kind: z.literal('timeOfDay'),
    at: timeStringSchema,
    days: z.array(dayOfWeekSchema).min(1).optional(),
  }).strict(),
])

/** Per-action clamp band (layer 1 of the two-layer temp clamp). */
export const automationClampSchema = z
  .object({ min: temperatureSchema, max: temperatureSchema })
  .strict()
  .refine(b => b.min <= b.max, { message: 'Clamp min must be <= max' })

/** Action (THEN). `notify` is the no-hardware safe default. */
export const automationActionSchema = z.union([
  z.object({ kind: z.literal('notify'), message: z.string().min(1).max(280) }).strict(),
  z.object({
    kind: z.literal('setTemperature'),
    side: sideSchema.optional(),
    temp: automationExprSchema,
    clamp: automationClampSchema.optional(),
    durationSec: z.number().int().min(0).max(86400).optional(),
  }).strict(),
  z.object({
    kind: z.literal('setPower'),
    side: sideSchema.optional(),
    on: z.boolean(),
    temp: automationExprSchema.optional(),
  }).strict(),
])

// Bound recursive AST size so a hostile or oversized payload can't degrade
// parse/eval and stall the periodic tick or a backtest. Real editor rules are
// tiny; these caps are generous headroom over anything the builder produces.
const AUTOMATION_MAX_AST_DEPTH = 16
const AUTOMATION_MAX_AST_NODES = 400

function measureExpr(e: AutomationExpr, depth: number): { depth: number, nodes: number } {
  switch (e.kind) {
    case 'literal':
    case 'signal':
    case 'window':
      return { depth, nodes: 1 }
    case 'binary': {
      const l = measureExpr(e.left, depth + 1)
      const r = measureExpr(e.right, depth + 1)
      return { depth: Math.max(l.depth, r.depth), nodes: 1 + l.nodes + r.nodes }
    }
    case 'clamp': {
      const v = measureExpr(e.value, depth + 1)
      const lo = measureExpr(e.min, depth + 1)
      const hi = measureExpr(e.max, depth + 1)
      return { depth: Math.max(v.depth, lo.depth, hi.depth), nodes: 1 + v.nodes + lo.nodes + hi.nodes }
    }
  }
}

function measureCondition(c: AutomationCondition, depth: number): { depth: number, nodes: number } {
  switch (c.kind) {
    case 'and':
    case 'or': {
      let d = depth
      let n = 1
      for (const child of c.conditions) {
        const m = measureCondition(child, depth + 1)
        d = Math.max(d, m.depth)
        n += m.nodes
      }
      return { depth: d, nodes: n }
    }
    case 'not': {
      const m = measureCondition(c.condition, depth + 1)
      return { depth: m.depth, nodes: 1 + m.nodes }
    }
    case 'compare': {
      const l = measureExpr(c.left, depth + 1)
      const r = measureExpr(c.right, depth + 1)
      return { depth: Math.max(l.depth, r.depth), nodes: 1 + l.nodes + r.nodes }
    }
    case 'between': {
      const s = measureExpr(c.subject, depth + 1)
      const lo = measureExpr(c.min, depth + 1)
      const hi = measureExpr(c.max, depth + 1)
      return { depth: Math.max(s.depth, lo.depth, hi.depth), nodes: 1 + s.nodes + lo.nodes + hi.nodes }
    }
    case 'timeBetween':
    case 'onDays':
      return { depth, nodes: 1 }
  }
}

function enforceAstBounds(
  val: { conditions?: AutomationCondition, actions?: ReadonlyArray<{ kind: string, temp?: AutomationExpr }> },
  ctx: z.RefinementCtx,
): void {
  let depth = 0
  let nodes = 0
  if (val.conditions) {
    const m = measureCondition(val.conditions, 1)
    depth = Math.max(depth, m.depth)
    nodes += m.nodes
  }
  for (const a of val.actions ?? []) {
    if (a.temp) {
      const m = measureExpr(a.temp, 1)
      depth = Math.max(depth, m.depth)
      nodes += m.nodes
    }
  }
  if (depth > AUTOMATION_MAX_AST_DEPTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Rule AST too deep (${depth} > ${AUTOMATION_MAX_AST_DEPTH})` })
  }
  if (nodes > AUTOMATION_MAX_AST_NODES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Rule AST too large (${nodes} > ${AUTOMATION_MAX_AST_NODES} nodes)` })
  }
}

/** Full automation create payload. */
const automationCreateObject = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  side: sideSchema.nullable().default(null),
  priority: z.number().int().min(0).max(1000).default(0),
  dryRun: z.boolean().default(true),
  cooldownMin: z.number().int().min(0).max(1440).nullable().default(null),
  trigger: automationTriggerSchema,
  conditions: automationConditionSchema,
  actions: z.array(automationActionSchema).min(1).max(10),
}).strict()

export const automationCreateSchema = automationCreateObject.superRefine(enforceAstBounds)

/** Update payload — all fields optional, keyed by id. */
export const automationUpdateSchema = automationCreateObject
  .partial()
  .extend({ id: idSchema })
  .superRefine(enforceAstBounds)
