import { describe, expect, it, vi } from 'vitest'

interface SafeParseResult {
  success: boolean
  error?: {
    issues: Array<{ message: string }>
  }
}

const baseAutomation = {
  name: 'x',
  trigger: { kind: 'tick', everyMin: 1 },
  conditions: { kind: 'and', conditions: [] },
  actions: [{ kind: 'notify', message: 'x' }],
}

async function loadSchemas() {
  // These schemas are constructed at module load. Stryker activates a static
  // mutant after Vitest has collected the suite, so a cached import would keep
  // exercising the original schema and report a false survivor.
  vi.resetModules()
  return import('../validation-schemas')
}

function expectMessage(result: SafeParseResult, message: string): void {
  expect(result.success).toBe(false)
  expect(result.error?.issues[0]?.message).toBe(message)
}

describe('validation schema mutation boundaries', () => {
  it('pins primitive schema boundaries and their public error messages', async () => {
    const {
      alarmDurationSchema,
      idSchema,
      temperatureSchema,
      timeStringSchema,
      vibrationIntensitySchema,
    } = await loadSchemas()

    expect(timeStringSchema.safeParse('x12:34').success).toBe(false)
    expect(timeStringSchema.safeParse('12:34x').success).toBe(false)
    expectMessage(
      timeStringSchema.safeParse('24:00'),
      'Time must be in HH:MM format (00:00-23:59)',
    )

    expectMessage(temperatureSchema.safeParse(55.5), 'Temperature must be a whole number')
    expectMessage(temperatureSchema.safeParse(54), 'Temperature must be at least 55°F')
    expectMessage(temperatureSchema.safeParse(111), 'Temperature must not exceed 110°F')

    expectMessage(idSchema.safeParse(1.5), 'ID must be an integer')
    expectMessage(idSchema.safeParse(0), 'ID must be positive')

    expectMessage(vibrationIntensitySchema.safeParse(1.5), 'Intensity must be a whole number')
    expectMessage(vibrationIntensitySchema.safeParse(0), 'Intensity must be at least 1')
    expectMessage(vibrationIntensitySchema.safeParse(101), 'Intensity must not exceed 100')

    expectMessage(alarmDurationSchema.safeParse(1.5), 'Duration must be a whole number')
    expectMessage(alarmDurationSchema.safeParse(-1), 'Duration must be at least 0 seconds')
    expectMessage(alarmDurationSchema.safeParse(181), 'Duration must not exceed 180 seconds')
  })

  it('pins ISO offsets and every signal-key regex boundary', async () => {
    const { isoDatetimeSchema, signalKeySchema } = await loadSchemas()

    expect(isoDatetimeSchema.safeParse('2026-07-27T12:34:56+05:30').success).toBe(true)
    expectMessage(
      isoDatetimeSchema.safeParse('not-a-date'),
      'Must be a valid ISO 8601 datetime string',
    )

    expect(signalKeySchema.safeParse('a').success).toBe(true)
    expect(signalKeySchema.safeParse('ab').success).toBe(true)
    expect(signalKeySchema.safeParse('a.b').success).toBe(true)
    expect(signalKeySchema.safeParse('a.bc').success).toBe(true)
    expect(signalKeySchema.safeParse('!a').success).toBe(false)
    expect(signalKeySchema.safeParse('a!').success).toBe(false)
    expect(signalKeySchema.safeParse('a.').success).toBe(false)
    expect(signalKeySchema.safeParse('a.!').success).toBe(false)
    expectMessage(
      signalKeySchema.safeParse('bad key!'),
      'Signal must be a dotted identifier',
    )
  })

  it('pins enum members and automation trigger/action boundaries', async () => {
    const {
      automationActionSchema,
      automationClampSchema,
      automationTriggerSchema,
      binaryOpSchema,
      compareOpSchema,
      windowFnSchema,
    } = await loadSchemas()

    for (const value of ['avg', 'min', 'max', 'sum', 'count']) {
      expect(windowFnSchema.safeParse(value).success).toBe(true)
    }
    for (const value of ['>', '>=', '<', '<=', '==', '!=']) {
      expect(compareOpSchema.safeParse(value).success).toBe(true)
    }
    for (const value of ['+', '-', '*', '/']) {
      expect(binaryOpSchema.safeParse(value).success).toBe(true)
    }

    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 1 }).success).toBe(true)
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 1440 }).success).toBe(true)
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 0 }).success).toBe(false)
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 1441 }).success).toBe(false)
    expect(automationTriggerSchema.safeParse({
      kind: 'timeOfDay',
      at: '12:00',
      days: ['monday', 'tuesday'],
    }).success).toBe(true)

    expect(automationClampSchema.safeParse({ min: 70, max: 70 }).success).toBe(true)
    expectMessage(
      automationClampSchema.safeParse({ min: 71, max: 70 }),
      'Clamp min must be <= max',
    )

    expect(automationActionSchema.safeParse({ kind: 'notify', message: 'x' }).success).toBe(true)
    expect(automationActionSchema.safeParse({
      kind: 'notify',
      message: 'x'.repeat(280),
    }).success).toBe(true)
    expect(automationActionSchema.safeParse({
      kind: 'notify',
      message: 'x'.repeat(281),
    }).success).toBe(false)
    expect(automationActionSchema.safeParse({
      kind: 'setTemperature',
      temp: { kind: 'literal', value: 70 },
      durationSec: 0,
    }).success).toBe(true)
    expect(automationActionSchema.safeParse({
      kind: 'setTemperature',
      temp: { kind: 'literal', value: 70 },
      durationSec: 86400,
    }).success).toBe(true)
    expect(automationActionSchema.safeParse({
      kind: 'setTemperature',
      temp: { kind: 'literal', value: 70 },
      durationSec: -1,
    }).success).toBe(false)
    expect(automationActionSchema.safeParse({
      kind: 'setTemperature',
      temp: { kind: 'literal', value: 70 },
      durationSec: 86401,
    }).success).toBe(false)
  })

  it('pins create defaults and every collection/numeric boundary', async () => {
    const { automationCreateSchema } = await loadSchemas()
    const parsed = automationCreateSchema.parse(baseAutomation)

    expect(parsed.enabled).toBe(true)
    expect(parsed.dryRun).toBe(true)

    expect(automationCreateSchema.safeParse({
      ...baseAutomation,
      name: 'x'.repeat(120),
      priority: 0,
      cooldownMin: 0,
    }).success).toBe(true)
    expect(automationCreateSchema.safeParse({
      ...baseAutomation,
      priority: 1000,
      cooldownMin: 1440,
      actions: Array.from({ length: 10 }, () => ({ kind: 'notify', message: 'x' })),
    }).success).toBe(true)

    expect(automationCreateSchema.safeParse({
      ...baseAutomation,
      name: 'x'.repeat(121),
    }).success).toBe(false)
    expect(automationCreateSchema.safeParse({
      ...baseAutomation,
      priority: -1,
    }).success).toBe(false)
    expect(automationCreateSchema.safeParse({
      ...baseAutomation,
      priority: 1001,
    }).success).toBe(false)
    expect(automationCreateSchema.safeParse({
      ...baseAutomation,
      cooldownMin: -1,
    }).success).toBe(false)
    expect(automationCreateSchema.safeParse({
      ...baseAutomation,
      cooldownMin: 1441,
    }).success).toBe(false)
    expect(automationCreateSchema.safeParse({
      ...baseAutomation,
      actions: Array.from({ length: 11 }, () => ({ kind: 'notify', message: 'x' })),
    }).success).toBe(false)
  })
})
