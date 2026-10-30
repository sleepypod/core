import { required } from '@/src/alarms/tests/required'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { beforeControlWrite } from '@/src/controls/context'
import { dispatchAlarm } from '../dispatch'
import { selectedAlarm } from '../model'
import { alarmFixture } from './fixture'
let fixture: ReturnType<typeof alarmFixture>
beforeEach(() => {
  fixture = alarmFixture()
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-26T07:00:00Z')
})
afterEach(() => {
  fixture.database.close()
  vi.useRealTimers()
})

it('checks the current plan again after a queued command is delayed', async () => {
  const candidate = required(selectedAlarm(fixture.store.context('left'), fixture.now), 'alarm fixture')
  expect(fixture.store.claim('left', candidate, Date.now(), false)).toBe(true)
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const write = vi.fn()
  const sent = dispatchAlarm(fixture.store, 'left', candidate, false, async () => {
    await wait
    beforeControlWrite()
    write()
  })
  fixture.database.exec('UPDATE alarm_schedules SET enabled=0')
  release()
  await expect(sent).rejects.toThrow('changed')
  expect(write).not.toHaveBeenCalled()
})
it('expires at the queue boundary and also rejects wall-clock rollback', async () => {
  const candidate = required(selectedAlarm(fixture.store.context('left'), fixture.now), 'alarm fixture')
  fixture.store.claim('left', candidate, Date.now(), false)
  await expect(dispatchAlarm(fixture.store, 'left', candidate, false, async () => {
    vi.setSystemTime('2026-10-26T07:01:00Z')
    beforeControlWrite()
  })).rejects.toThrow('expired')
  vi.setSystemTime('2026-10-26T07:00:00Z')
  await expect(dispatchAlarm(fixture.store, 'left', candidate, false, async () => {
    vi.setSystemTime('2026-10-26T06:59:59Z')
    beforeControlWrite()
  })).rejects.toThrow('expired')
})
it('allows exactly one write in its dispatch scope', async () => {
  const candidate = required(selectedAlarm(fixture.store.context('left'), fixture.now), 'alarm fixture')
  fixture.store.claim('left', candidate, Date.now(), false)
  const write = vi.fn()
  await expect(dispatchAlarm(fixture.store, 'left', candidate, false, async () => {
    beforeControlWrite()
    write()
    beforeControlWrite()
    write()
  })).rejects.toThrow('already dispatched')
  expect(write).toHaveBeenCalledTimes(1)
})
