import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { alarmFixture, insertAlarm } from './fixture'
import { required } from './required'

let fixture: ReturnType<typeof alarmFixture>
beforeEach(() => {
  fixture = alarmFixture()
})
afterEach(() => fixture.database.close())
function input(time = '09:00', now = fixture.now) {
  const before = fixture.store.page('left', now)
  return { side: 'left' as const, time, expectedRevision: before.revision, expectedAt: required(before.alarm, 'fixture alarm').at }
}
function snapshot() {
  return ['alarm_schedules', 'alarm_overrides', 'alarm_occurrences', 'side_settings', 'device_settings']
    .map(table => fixture.database.prepare(`SELECT * FROM ${table}`).all())
}

describe('later wake review', () => {
  it('previews without writes and matches the actual one-occurrence save and weekly restoration', () => {
    const original = snapshot()
    const preview = fixture.store.previewLater(input(), fixture.now)
    expect(snapshot()).toEqual(original)
    expect(preview).toMatchObject({ effect: 'preview_only', weeklyScheduleChanged: false, externalDevices: 'not_included',
      generatedAt: '2026-10-26T05:00:00.000Z', expiresAt: '2026-10-26T05:01:30.000Z',
      proposed: { at: '2026-10-26T09:00:00.000Z', warmingStartsAt: '2026-10-26T08:30:00.000Z',
        earliestVibrationAt: '2026-10-26T09:00:00.000Z', warmingEndsAt: '2026-10-26T09:16:00.000Z', duration: 60, targetF: 80 } })
    const saved = fixture.store.write(preview.request, fixture.now)
    expect(saved.alarm?.at).toBe(preview.proposed.at)
    expect(saved.warming).toEqual({ startsAt: preview.proposed.warmingStartsAt, endsAt: preview.proposed.warmingEndsAt,
      earliestVibrationAt: preview.proposed.earliestVibrationAt, targetF: preview.proposed.targetF })
    expect(saved.change?.expiresAt).toBe(preview.proposed.changeExpiresAt)
    const afterExpiry = fixture.store.page('left', Date.parse(preview.proposed.changeExpiresAt))
    expect(afterExpiry.alarm?.at).toBe('2026-11-02T07:00:00.000Z')
    expect(snapshot()[0]).toEqual(original[0])
  })
  it('expires no later than the beginning of the existing warming period', () => {
    const now = Date.parse('2026-10-26T06:29:30Z')
    expect(fixture.store.previewLater(input('08:00', now), now).expiresAt).toBe('2026-10-26T06:30:00.000Z')
    const warming = Date.parse('2026-10-26T06:30:00Z')
    expect(() => fixture.store.previewLater(input('08:00', warming), warming)).toThrow('already begun')
  })
  it('preserves duration, target and long movement windows in the preview', () => {
    fixture.database.exec('UPDATE alarm_schedules SET wake_window=60,duration=20,alarm_temperature=105')
    const preview = fixture.store.previewLater(input(), fixture.now)
    const saved = fixture.store.write(preview.request, fixture.now)
    expect(preview.proposed).toMatchObject({ duration: 20, targetF: 105, wakeWindow: 60, warmingStartsAt: '2026-10-26T08:00:00.000Z', earliestVibrationAt: '2026-10-26T08:00:00.000Z' })
    expect(saved.warming?.startsAt).toBe(preview.proposed.warmingStartsAt)
  })
  it('requires a later, unambiguous time before the following alarm', () => {
    for (const time of ['06:00', '07:00']) expect(() => fixture.store.previewLater(input(time), fixture.now)).toThrow('later')
    insertAlarm(fixture.database, 'left', '09:30')
    for (const time of ['09:30', '10:00']) expect(() => fixture.store.previewLater(input(time), fixture.now)).toThrow('cross')
    expect(() => fixture.store.previewLater({ ...input(), time: '24:00' }, fixture.now)).toThrow()
  })
  it('rejects stale review identity, changed schedules and inactive or skipped occurrences', () => {
    const earlier = input()
    fixture.database.exec('UPDATE alarm_schedules SET duration=20')
    expect(() => fixture.store.previewLater(earlier, fixture.now)).toThrow('changed')
    const current = input()
    fixture.store.write({ ...current, action: 'skip', time: undefined }, fixture.now)
    expect(() => fixture.store.previewLater(input(), fixture.now)).toThrow('changed')
    fixture.database.exec('UPDATE side_settings SET away_mode=1 WHERE side=\'left\'')
    expect(() => fixture.store.previewLater(input(), fixture.now)).toThrow('changed')
  })
  it('keeps the original wake occurrence when a later change is revised again', () => {
    const first = fixture.store.previewLater(input('08:00'), fixture.now)
    fixture.store.write(first.request, fixture.now)
    const second = fixture.store.previewLater(input('09:00'), fixture.now)
    expect(second.before.alarm).toMatchObject({ at: '2026-10-26T08:00:00.000Z', originalAt: '2026-10-26T07:00:00.000Z' })
    expect(fixture.store.write(second.request, fixture.now).alarm?.originalAt).toBe(first.before.alarm?.originalAt)
  })
  it.each([
    ['2026-11-01T06:00:00Z', '01:30'],
    ['2026-03-08T06:00:00Z', '02:30'],
  ])('rejects a repeated or skipped daylight-saving time (%s)', (nowText, time) => {
    fixture.database.exec('UPDATE device_settings SET timezone=\'America/Los_Angeles\'; UPDATE alarm_schedules SET day_of_week=\'sunday\',time=\'00:30\'')
    const now = Date.parse(nowText)
    expect(() => fixture.store.previewLater(input(time, now), now)).toThrow('clock changes')
  })
  it('resolves the Pod timezone instead of using a client timezone', () => {
    fixture.database.exec('UPDATE device_settings SET timezone=\'America/Los_Angeles\'')
    const preview = fixture.store.previewLater(input('09:00'), fixture.now)
    expect(preview.before.timeZone).toBe('America/Los_Angeles')
    expect(preview.proposed.at).toBe('2026-10-26T16:00:00.000Z')
  })
})

describe('apply a reviewed later wake', () => {
  it('saves exactly the reviewed plan once and rejects a replay', () => {
    const preview = fixture.store.previewLater(input(), fixture.now)
    const saved = fixture.store.applyLater(preview, fixture.now + 30_000)
    expect(saved.alarm?.at).toBe(preview.proposed.at)
    expect(saved.warming?.startsAt).toBe(preview.proposed.warmingStartsAt)
    expect(saved.change?.expiresAt).toBe(preview.proposed.changeExpiresAt)
    expect(() => fixture.store.applyLater(preview, fixture.now + 31_000)).toThrow('changed')
  })
  it.each([-1, 90_000, 120_000])('rejects rollback or expiry at %s milliseconds without writing', (offset) => {
    const preview = fixture.store.previewLater(input(), fixture.now)
    const original = snapshot()
    expect(() => fixture.store.applyLater(preview, fixture.now + offset)).toThrow('expired')
    expect(snapshot()).toEqual(original)
  })
  it('rejects modified evidence, extended expiry and altered write requests', () => {
    const preview = fixture.store.previewLater(input(), fixture.now)
    const original = snapshot()
    const variants = [
      { ...preview, proposed: { ...preview.proposed, targetF: 105 } },
      { ...preview, proposed: { ...preview.proposed, warmingStartsAt: '2026-10-26T08:45:00.000Z' } },
      { ...preview, request: { ...preview.request, time: '10:00' } },
      { ...preview, expiresAt: new Date(fixture.now + 180_000).toISOString() },
    ]
    for (const changed of variants) expect(() => fixture.store.applyLater(changed, fixture.now)).toThrow('no longer matches')
    expect(snapshot()).toEqual(original)
  })
  it('rejects a concurrent plan change without replacing it', () => {
    const preview = fixture.store.previewLater(input(), fixture.now)
    fixture.database.exec('UPDATE alarm_schedules SET duration=20')
    const original = snapshot()
    expect(() => fixture.store.applyLater(preview, fixture.now + 1000)).toThrow('changed')
    expect(snapshot()).toEqual(original)
  })
})
