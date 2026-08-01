import { describe, expect, it, vi } from 'vitest'

const completeDeviceData = {
  tgHeatLevelR: '50',
  tgHeatLevelL: '-30',
  heatTimeL: '1800',
  heatLevelL: '-25',
  heatTimeR: '3600',
  heatLevelR: '45',
  sensorLabel: '8SLEEP-SN-12345-I00',
  waterLevel: 'true',
  priming: 'false',
} as const

async function loadRawDeviceDataSchema() {
  // The schema is constructed at module load. Stryker activates static mutants
  // after Vitest collects the suite, so a cached import would exercise the
  // original regexes and enum members and report false survivors.
  vi.resetModules()
  const { rawDeviceDataSchema } = await import('../types')
  return rawDeviceDataSchema
}

describe('rawDeviceDataSchema mutation boundaries', () => {
  it('pins every signed integer field to the complete decimal wire format', async () => {
    const schema = await loadRawDeviceDataSchema()
    const fields = ['tgHeatLevelR', 'tgHeatLevelL', 'heatLevelL', 'heatLevelR'] as const

    for (const field of fields) {
      for (const valid of ['0', '50', '-50', '123']) {
        expect(
          schema.safeParse({ ...completeDeviceData, [field]: valid }).success,
          `${field} rejected ${valid}`,
        ).toBe(true)
      }

      for (const invalid of ['x50', '50x', '--50', '+50', '5.0', 'word']) {
        expect(
          schema.safeParse({ ...completeDeviceData, [field]: invalid }).success,
          `${field} accepted ${invalid}`,
        ).toBe(false)
      }
    }
  })

  it('pins both duration fields to complete unsigned decimal strings', async () => {
    const schema = await loadRawDeviceDataSchema()
    const fields = ['heatTimeL', 'heatTimeR'] as const

    for (const field of fields) {
      for (const valid of ['0', '9', '1800']) {
        expect(
          schema.safeParse({ ...completeDeviceData, [field]: valid }).success,
          `${field} rejected ${valid}`,
        ).toBe(true)
      }

      for (const invalid of ['x1800', '1800x', '-1800', '+1800', '18.00', 'word']) {
        expect(
          schema.safeParse({ ...completeDeviceData, [field]: invalid }).success,
          `${field} accepted ${invalid}`,
        ).toBe(false)
      }
    }
  })

  it('pins both boolean wire fields to their two exact enum members', async () => {
    const schema = await loadRawDeviceDataSchema()

    for (const field of ['waterLevel', 'priming'] as const) {
      for (const valid of ['true', 'false']) {
        expect(
          schema.safeParse({ ...completeDeviceData, [field]: valid }).success,
          `${field} rejected ${valid}`,
        ).toBe(true)
      }

      for (const invalid of ['', 'TRUE', 'False', '0', '1']) {
        expect(
          schema.safeParse({ ...completeDeviceData, [field]: invalid }).success,
          `${field} accepted ${invalid}`,
        ).toBe(false)
      }
    }
  })
})
