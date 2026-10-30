import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { beforeControlWrite } from '@/src/controls/context'
import { personalBedSchema } from '../bedContract'
import { personalRuntimeFixture } from './runtimeFixture'

let fixture: ReturnType<typeof personalRuntimeFixture>
const currentRequest = () => {}
beforeEach(() => {
  fixture = personalRuntimeFixture()
})
afterEach(() => fixture.database.close())

describe('database-derived personal authority', () => {
  it('grants the sole owner both thermal zones but keeps scheduled vibration on the source side', async () => {
    const result = personalBedSchema.parse(await fixture.runtime.bed(fixture.ownerKey, currentRequest))
    expect(result).toMatchObject({ arrangement: 'solo-anywhere', availability: 'ready',
      routing: { temperature: ['left', 'right'], power: ['left', 'right'], vibrationCancellation: ['left', 'right'], scheduledVibration: ['left'], routines: 'left' },
      observation: { state: 'fresh', water: 'ok', priming: false }, physicalVerification: 'unverified' })
    expect(result.zones).toEqual([
      { side: 'left', measuredTemperatureF: 69, reportedTargetF: 70, reportedPowered: true, requestedTargetF: 68 },
      { side: 'right', measuredTemperatureF: 81, reportedTargetF: 82, reportedPowered: true, requestedTargetF: 80 },
    ])
    expect(fixture.runtime.session(fixture.identities.session(fixture.ownerKey)).capabilities.personalControls).toBe(true)
  })

  it('does not read hardware or grant controls when the runtime is disabled or the partner is unassigned', async () => {
    const partner = await fixture.runtime.bed(fixture.memberKey, currentRequest)
    expect(partner).toMatchObject({ availability: 'unassigned', zones: [], routing: { routines: null, scheduledVibration: [], temperature: [] } })
    await expect(fixture.runtime.submit(fixture.memberKey, fixture.command(fixture.memberKey), currentRequest)).rejects.toThrow('unavailable')
    fixture.clock.enabled = false
    expect(await fixture.runtime.bed(fixture.ownerKey, currentRequest)).toMatchObject({ availability: 'runtime_disabled', zones: [] })
    expect(fixture.runtime.session(fixture.identities.session(fixture.ownerKey)).capabilities.personalControls).toBe(false)
    expect(fixture.observe).not.toHaveBeenCalled()
    expect(fixture.requestedTarget).not.toHaveBeenCalled()
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('uses current assigned identity for reads, writes and sessions without leaking the other side', async () => {
    fixture.assignedFixture()
    for (const [key, side] of [[fixture.ownerKey, 'right'], [fixture.memberKey, 'left']] as const) {
      const result = await fixture.runtime.bed(key, currentRequest)
      expect(result.zones.map(zone => zone.side)).toEqual([side])
      expect(result.routing).toEqual({ temperature: [side], power: [side], vibrationCancellation: [side], scheduledVibration: [side], routines: side })
      expect(fixture.runtime.session(fixture.identities.session(key)).self).toMatchObject({ zones: [side], assignment: side })
      expect(await fixture.runtime.submit(key, fixture.command(key), currentRequest)).toMatchObject({ state: 'acknowledged', resolvedZones: [side], dispatchCount: 1 })
    }
    const partner = JSON.stringify(await fixture.runtime.bed(fixture.memberKey, currentRequest))
    for (const excluded of ['rightSide', 'right', 'sensorLabel', 'private-diagnostics', 'gestures', 'doubleTap', fixture.owner.selfSleeperId])
      expect(partner).not.toContain(excluded)
    expect(fixture.execute.mock.calls.map(([action]) => 'side' in action && action.side)).toEqual(['right', 'left'])
  })

  it.each([
    'UPDATE device_settings SET bed_mode = \'two\'',
    'UPDATE device_settings SET unused_zone_mode = \'independent\'',
    'UPDATE household_accounts SET assigned_side = \'left\' WHERE role = \'member\'',
    'DELETE FROM device_settings',
  ])('denies a mismatched physical arrangement: %s', async (mutation) => {
    fixture.database.exec(mutation)
    expect(await fixture.runtime.bed(fixture.ownerKey, currentRequest)).toMatchObject({ availability: 'configuration_changed', zones: [] })
    await expect(fixture.runtime.submit(fixture.ownerKey, fixture.command(), currentRequest)).rejects.toThrow('unavailable')
    expect(fixture.observe).not.toHaveBeenCalled()
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it.each([
    'UPDATE device_settings SET timezone = \'America/New_York\'',
    'UPDATE side_settings SET away_mode = 1 WHERE side = \'right\'',
    'UPDATE households SET assignment_revision = assignment_revision + 1',
  ])('rejects a queued command after the current configuration changes: %s', async (mutation) => {
    const input = fixture.command()
    fixture.execute.mockImplementationOnce(async () => {
      fixture.database.exec(mutation)
      beforeControlWrite()
    })
    expect(await fixture.runtime.submit(fixture.ownerKey, input, currentRequest)).toMatchObject({ state: 'rejected', dispatchCount: 0 })
    expect(fixture.execute).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.authority.resolve(fixture.ownerKey).scope).not.toEqual(input.scope)
  })

  it('rejects an old command after a side move but preserves the old receipt for its author', async () => {
    const input = fixture.command()
    const receipt = await fixture.runtime.submit(fixture.ownerKey, input, currentRequest)
    fixture.assignedFixture()
    expect(await fixture.runtime.submit(fixture.ownerKey, input, currentRequest)).toEqual(receipt)
    expect(fixture.runtime.receipt(fixture.memberKey, input.requestId, currentRequest)).toBeNull()
    expect(fixture.execute).toHaveBeenCalledTimes(2)
  })

  it('allows multiple unassigned accounts but rejects duplicate assigned zones in SQLite', () => {
    expect(fixture.database.prepare('SELECT assigned_side FROM household_accounts').all()).toEqual([{ assigned_side: null }, { assigned_side: null }])
    fixture.assignedFixture()
    expect(() => fixture.database.prepare('UPDATE household_accounts SET assigned_side = \'right\' WHERE role = \'member\'').run()).toThrow('UNIQUE')
    expect(fixture.identities.session(fixture.memberKey).self.assignment).toBe('left')
  })
})

describe('personal observation freshness', () => {
  it.each([-1, 15_000, 60_000, Number.NaN])('does not present invalid or stale observation age %s as live values', async (age) => {
    fixture.observation.observedAt = fixture.clock.now - age
    const result = await fixture.runtime.bed(fixture.ownerKey, currentRequest)
    expect(result.observation).toEqual({ state: 'unavailable', observedAt: null, water: 'unknown', priming: null })
    expect(result.zones.every(zone => zone.reportedPowered === null && zone.measuredTemperatureF === null && zone.reportedTargetF === null)).toBe(true)
    expect(result.zones[0].requestedTargetF).toBe(68)
  })

  it('keeps unavailable readings and unavailable intent explicit after transport failures', async () => {
    fixture.observe.mockRejectedValueOnce(new Error('transport disconnected'))
    fixture.requestedTarget.mockImplementation(() => {
      throw new Error('controller not started')
    })
    const result = await fixture.runtime.bed(fixture.ownerKey, currentRequest)
    expect(result.observation.state).toBe('unavailable')
    expect(result.zones.every(zone => zone.requestedTargetF === null)).toBe(true)
  })

  it('does not infer active power from a target with no remaining heating evidence', async () => {
    fixture.observation.status.leftSide.heatingDuration = 0
    fixture.observation.status.rightSide.targetLevel = 0
    expect((await fixture.runtime.bed(fixture.ownerKey, currentRequest)).zones.map(zone => zone.reportedPowered)).toEqual([null, false])
  })

  it('discards observations after an assignment changes during the read', async () => {
    fixture.observe.mockImplementationOnce(async () => {
      fixture.assignedFixture()
      return fixture.observation
    })
    await expect(fixture.runtime.bed(fixture.ownerKey, currentRequest)).rejects.toThrow('configuration changed')
    expect(fixture.requestedTarget).not.toHaveBeenCalled()
  })

  it('rechecks device revocation after reading and never returns the private snapshot', async () => {
    const deviceId = fixture.identities.deviceIdentity(fixture.ownerKey)
    fixture.observe.mockImplementationOnce(async () => {
      fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?').run(fixture.clock.now, deviceId)
      return fixture.observation
    })
    await expect(fixture.runtime.bed(fixture.ownerKey, currentRequest)).rejects.toThrow()
    expect(fixture.requestedTarget).not.toHaveBeenCalled()
  })
})
