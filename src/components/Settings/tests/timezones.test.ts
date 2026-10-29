import { describe, expect, it } from 'vitest'
import { timezoneSchema } from '@/src/server/validation-schemas'
import { TIMEZONES } from '../DeviceSettingsForm'

describe('TIMEZONES', () => {
  it('only offers zones the server accepts', () => {
    for (const tz of TIMEZONES) {
      expect(timezoneSchema.safeParse(tz).success, tz).toBe(true)
    }
  })

  it('has no duplicates', () => {
    expect(new Set(TIMEZONES).size).toBe(TIMEZONES.length)
  })

  it('includes Europe/Bucharest', () => {
    expect(TIMEZONES).toContain('Europe/Bucharest')
  })
})
