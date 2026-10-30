import { describe, expect, it } from 'vitest'
import fixtures from '../fixtures/personal-controls-v1.json'
import { personalBedSchema } from '../bedContract'
import { personalControlReceiptSchema, personalControlRequestSchema } from '../controlContract'
import { householdErrorSchema } from '../contract'

describe('frozen web/native personal control contract', () => {
  it('decodes the public fixtures with explicit unavailable and partial-result states', () => {
    for (const fixture of [fixtures.soloBed, fixtures.assignedBed, fixtures.unassignedBed, fixtures.disabledBed])
      expect(personalBedSchema.parse(fixture)).toEqual(fixture)
    expect(personalControlRequestSchema.parse(fixtures.temperatureRequest)).toEqual(fixtures.temperatureRequest)
    for (const fixture of [fixtures.acknowledged, fixtures.partialUnknown])
      expect(personalControlReceiptSchema.parse(fixture)).toEqual(fixture)
    expect(householdErrorSchema.parse(fixtures.missingReceipt)).toEqual(fixtures.missingReceipt)
  })

  it('does not accept an all-side raw snapshot or private diagnostic fields in the personal response', () => {
    expect(personalBedSchema.safeParse({ ...fixtures.assignedBed, rightSide: { currentTemperature: 80 } }).success).toBe(false)
    expect(personalBedSchema.safeParse({ ...fixtures.assignedBed, zones: [{ ...fixtures.assignedBed.zones[0], heartRate: 62 }] }).success).toBe(false)
  })
})
