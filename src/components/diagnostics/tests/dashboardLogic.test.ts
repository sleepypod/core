import { describe, expect, it } from 'vitest'
import {
  attentionItems, isPodLaneJob, jobsInWindow, nextTemperatureJob, podJobLabel, tonightWindow,
} from '../dashboardLogic'
import type { SchedJob } from '../diagnosticsLogic'

const job = (over: Partial<SchedJob>): SchedJob => ({ id: 'j', type: 'temperature', nextRun: null, ...over })
const name = (s: 'left' | 'right') => (s === 'left' ? 'Jon' : 'Heidi')

describe('tonightWindow', () => {
  it('uses today in the evening', () => {
    const w = tonightWindow(new Date(2026, 8, 28, 20, 0)) // Monday
    expect(w.day).toBe('monday')
    expect(new Date(w.start)).toEqual(new Date(2026, 8, 28, 17))
    expect(new Date(w.end)).toEqual(new Date(2026, 8, 29, 9))
  })
  it('stays on last night until 9 AM', () => {
    expect(tonightWindow(new Date(2026, 8, 29, 6, 30)).day).toBe('monday')
    expect(tonightWindow(new Date(2026, 8, 29, 9, 0)).day).toBe('tuesday')
  })
})

describe('scheduler jobs', () => {
  const w = { start: new Date(2026, 8, 28, 17).getTime(), end: new Date(2026, 8, 29, 9).getTime() }
  it('keeps jobs inside the window in time order', () => {
    const jobs = [
      job({ id: 'b', nextRun: new Date(2026, 8, 29, 3).toISOString() }),
      job({ id: 'a', nextRun: new Date(2026, 8, 28, 22).toISOString() }),
      job({ id: 'late', nextRun: new Date(2026, 8, 29, 14).toISOString() }),
      job({ id: 'none', nextRun: null }),
    ]
    expect(jobsInWindow(jobs, w).map(j => j.id)).toEqual(['a', 'b'])
  })
  it('labels pod jobs for humans', () => {
    expect(podJobLabel(job({ type: 'led_brightness', brightness: 2 }), name)).toBe('LED 2%')
    expect(podJobLabel(job({ type: 'reboot' }), name)).toBe('Reboot')
    expect(podJobLabel(job({ type: 'alarm', side: 'right' }), name)).toBe('Alarm · Heidi')
    expect(podJobLabel(job({ type: 'something_new' }), name)).toBe('Something new')
  })
  it('keeps temperature and power off the pod lane', () => {
    expect(['temperature', 'power_on', 'power_off', 'reboot'].map(type => isPodLaneJob(job({ type })))).toEqual([false, false, false, true])
  })
  it('finds the next temperature change', () => {
    const now = new Date(2026, 8, 28, 20).getTime()
    const jobs = [
      job({ id: 'past', targetTempF: 70, nextRun: new Date(2026, 8, 28, 19).toISOString() }),
      job({ id: 'led', type: 'led_brightness', nextRun: new Date(2026, 8, 28, 21).toISOString() }),
      job({ id: 'next', targetTempF: 80, nextRun: new Date(2026, 8, 28, 23).toISOString() }),
    ]
    expect(nextTemperatureJob(jobs, now)?.id).toBe('next')
    expect(nextTemperatureJob([], now)).toBeNull()
  })
})

describe('attentionItems', () => {
  const now = new Date(2026, 8, 28, 20).getTime()
  const ok = { pumpStallProtectionEnabled: true, primePodDaily: false, lastPrimeAt: now - 86_400_000 }

  it('is empty when the guard is on and the pod primed recently', () => {
    expect(attentionItems(ok, 'ok', now)).toEqual([])
    expect(attentionItems(undefined, undefined, now)).toEqual([])
  })

  it('leads with a side that reads occupied but looks empty', () => {
    const items = attentionItems(ok, 'ok', now, ['left'])
    expect(items.map(i => i.id)).toEqual(['occupancy'])
    expect(items[0].title).toBe('The left side reads occupied, but there are no vitals')
  })
  it('flags the pump-stall guard being off', () => {
    expect(attentionItems({ ...ok, pumpStallProtectionEnabled: false }, 'ok', now).map(i => i.id)).toEqual(['pump-stall'])
  })
  it('flags a stale or missing prime unless daily prime is on', () => {
    const stale = { ...ok, lastPrimeAt: now - 8 * 86_400_000 }
    const [item] = attentionItems(stale, 'ok', now)
    expect(item).toMatchObject({ id: 'prime', title: 'No prime in the last 7 days' })
    expect(item.detail).toMatch(/^Water level OK\. Last primed/)
    expect(attentionItems({ ...ok, lastPrimeAt: null }, 'ok', now)[0].title).toBe('No prime recorded yet')
    expect(attentionItems({ ...stale, primePodDaily: true }, 'ok', now)).toEqual([])
  })
  it('flags low water', () => {
    expect(attentionItems(ok, 'low', now).map(i => i.id)).toEqual(['water'])
  })
})
