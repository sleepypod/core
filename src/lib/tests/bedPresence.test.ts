import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BASELINE_STALE_MS,
  bedLoad,
  CollapsePresence,
  instantPresence,
  PresenceHold,
  readPresenceBaselines,
  sleepDetectorStatePath,
  type PresenceBaseline,
} from '../bedPresence'

const capSense: PresenceBaseline = { format: 'capSense', means: { out: 1000, cen: 1500, in: 1700 }, threshold: 300, refMean: null }
const capSense2: PresenceBaseline = { format: 'capSense2', means: { A: 10, B: 20, C: 30 }, threshold: 6, refMean: 1.2 }

describe('bedLoad', () => {
  it('sums the capSense channels\' rise over the empty-bed level', () => {
    // The live snapshot projects {out, cen, in} to [out, out, cen, cen, in, in].
    expect(bedLoad('capSense', [1100, 1100, 1700, 1700, 1750, 1750], capSense)).toBe(350)
    expect(bedLoad('capSense', [990, 990, 1490, 1490, 1695, 1695], capSense)).toBe(-25)
  })

  it('averages capSense2 pairs and subtracts the reference drift', () => {
    // Pairs average to 12.2, 23.2, 33.2; the reference reads 0.2 over its
    // empty level, so the drift-free load is 2 + 3 + 3.
    expect(bedLoad('capSense2', [11.9, 12.5, 23.1, 23.3, 33, 33.4, 1.4, 1.4], capSense2)).toBeCloseTo(8, 6)
    // Six-value frames carry no reference pair.
    expect(bedLoad('capSense2', [11, 13, 22, 24, 31, 35], capSense2)).toBeCloseTo(8, 6)
  })

  it('cannot read a frame of another format, a short frame, or a firmware read error', () => {
    expect(bedLoad('capSense2', [1, 1, 1, 1, 1, 1], capSense)).toBeNull()
    expect(bedLoad('capSense', [1100], capSense)).toBeNull()
    expect(bedLoad('capSense', 1100, capSense)).toBeNull()
    expect(bedLoad('capSense2', [11, -1, 22, 24, 31, 35, 1.2, 1.2], capSense2)).toBeNull()
  })

  it('cannot read a non-finite channel, which would otherwise read as an empty bed', () => {
    expect(bedLoad('capSense', [Number.NaN, Number.NaN, 1500, 1500, 1700, 1700], capSense)).toBeNull()
    expect(bedLoad('capSense', [1100, 1100, Infinity, Infinity, 1700, 1700], capSense)).toBeNull()
    expect(bedLoad('capSense2', [11, 13, 22, 24, 31, Number.NaN], capSense2)).toBeNull()
    expect(bedLoad('capSense2', [11, 13, 22, 24, 31, 35, -Infinity, 1.2], capSense2)).toBeNull()
  })
})

describe('instantPresence', () => {
  it('enters above the threshold and leaves below half of it', () => {
    expect(instantPresence(300, 300, false)).toBe(false)
    expect(instantPresence(301, 300, false)).toBe(true)
    // Once in bed, a load between half the threshold and the threshold stays in bed.
    expect(instantPresence(200, 300, true)).toBe(true)
    expect(instantPresence(150, 300, true)).toBe(false)
  })

  it('leaves below a set fraction of the threshold', () => {
    // A just-vacated mattress can read well above empty; a higher exit line catches it.
    expect(instantPresence(241, 300, true, 0.8)).toBe(true)
    expect(instantPresence(240, 300, true, 0.8)).toBe(false)
    // Entry is unchanged.
    expect(instantPresence(290, 300, false, 0.8)).toBe(false)
  })
})

describe('CollapsePresence', () => {
  const threshold = 300

  /** Feed `load` twice a second from `fromS` up to (not including) `toS`; returns the last result. */
  function feed(cp: CollapsePresence, load: number, fromS: number, toS: number) {
    let last = { load: Number.NaN, present: false }
    for (let ms = fromS * 1000; ms < toS * 1000; ms += 500) last = cp.update(load, ms, threshold)
    return last
  }

  /** In bed at `load` for the first 100 s. */
  function asleep(load = 2000) {
    const cp = new CollapsePresence()
    expect(feed(cp, load, 0, 100)).toEqual({ load, present: true })
    return cp
  }

  it('reads an exit once the load has stayed collapsed, though it is still over the line', () => {
    const cp = asleep()
    // 380 left on the bed: over the 150 exit line, a fifth of the load before.
    expect(feed(cp, 380, 100, 109.5)).toEqual({ load: 380, present: true })
    expect(cp.update(380, 109_500, threshold)).toEqual({ load: 0, present: false })
    expect(cp.residual).toBe(380)
  })

  it('treats the load left behind as empty, following it down but not up', () => {
    const cp = asleep()
    feed(cp, 380, 100, 110)
    // The mattress settles: the empty level follows.
    expect(cp.update(250, 110_000, threshold)).toEqual({ load: 0, present: false })
    expect(cp.residual).toBe(250)
    expect(cp.update(500, 110_500, threshold)).toEqual({ load: 250, present: false })
    expect(cp.residual).toBe(250)
    // Back in bed: a threshold over what was left, for 5 s.
    expect(cp.update(551, 111_000, threshold)).toEqual({ load: 301, present: false })
    expect(cp.update(551, 115_500, threshold)).toEqual({ load: 301, present: false })
    expect(cp.update(551, 116_000, threshold)).toEqual({ load: 301, present: true })
    // And out again by the ordinary line, the residual still on the bed.
    expect(cp.update(399, 116_500, threshold)).toEqual({ load: 149, present: false })
  })

  it('does not read pushing off the mattress after a collapse as getting back in', () => {
    const cp = asleep()
    feed(cp, 380, 100, 110)
    expect(cp.update(1200, 110_000, threshold).present).toBe(false)
    expect(cp.update(1100, 110_500, threshold).present).toBe(false)
    expect(cp.update(380, 111_000, threshold).present).toBe(false)
    // A new rise starts the 5 s over.
    expect(cp.update(1200, 111_500, threshold).present).toBe(false)
    expect(cp.update(1200, 116_000, threshold).present).toBe(false)
    expect(cp.update(1200, 116_500, threshold).present).toBe(true)
  })

  it('enters at once when nothing was left behind', () => {
    const cp = new CollapsePresence()
    expect(cp.update(0, 0, threshold).present).toBe(false)
    expect(cp.update(400, 500, threshold).present).toBe(true)
  })

  it('takes the highest reading of the collapse as the empty level', () => {
    const cp = asleep()
    feed(cp, 500, 100, 105)
    feed(cp, 300, 105, 109.5)
    expect(cp.update(300, 109_500, threshold)).toEqual({ load: -200, present: false })
    expect(cp.residual).toBe(500)
    cp.update(300, 110_000, threshold)
    expect(cp.residual).toBe(300)
  })

  it('does not read a short dip or a reading a third of the load as an exit', () => {
    const cp = asleep()
    feed(cp, 380, 100, 105)
    expect(feed(cp, 2000, 105, 200).present).toBe(true)
    // Exactly 30% of the load before is not a collapse; under it is.
    expect(feed(cp, 600, 200, 240)).toEqual({ load: 600, present: true })
    const under = asleep()
    expect(feed(under, 599, 100, 110)).toEqual({ load: 0, present: false })
  })

  it('needs the load to drop by at least 2.5 thresholds', () => {
    const light = asleep(999)
    expect(feed(light, 250, 100, 110)).toEqual({ load: 250, present: true })
    const enough = asleep(1000)
    expect(feed(enough, 250, 100, 110)).toEqual({ load: 0, present: false })
  })

  it('compares with the median load from 90 s to 30 s ago', () => {
    const cp = new CollapsePresence()
    // Low and high readings in the window; the median, not the peak, counts.
    feed(cp, 600, 0, 20)
    feed(cp, 4000, 20, 31)
    feed(cp, 600, 31, 60)
    // Median 600: a drop to 170 is not 2.5 thresholds.
    expect(feed(cp, 170, 60, 70)).toEqual({ load: 170, present: true })
    // Readings over 90 s old are gone, so the 4000s now set the median.
    const high = new CollapsePresence()
    feed(high, 600, 0, 30)
    feed(high, 2000, 30, 120)
    expect(feed(high, 170, 120, 130)).toEqual({ load: 0, present: false })
  })

  it('does not read a collapse without 10 s of readings before it, or after a reset', () => {
    const cp = new CollapsePresence()
    feed(cp, 2000, 0, 9.5)
    expect(feed(cp, 380, 9.5, 40)).toEqual({ load: 380, present: true })
    const reset = asleep()
    reset.reset()
    feed(reset, 2000, 100, 109.5)
    expect(feed(reset, 380, 109.5, 140)).toEqual({ load: 380, present: true })
    const kept = asleep()
    feed(kept, 2000, 100, 109.5)
    expect(feed(kept, 380, 109.5, 140)).toEqual({ load: 0, present: false })
  })

  it('needs 10 s of readings after the drop', () => {
    const cp = asleep()
    // Four readings 3 s apart: low, but too few to count.
    for (const ms of [100_000, 103_000, 106_000, 109_000]) expect(cp.update(380, ms, threshold).present).toBe(true)
  })

  it('applies the exit line set for the bridge', () => {
    const cp = new CollapsePresence()
    expect(cp.update(400, 0, threshold, 0.8)).toEqual({ load: 400, present: true })
    expect(cp.update(241, 500, threshold, 0.8).present).toBe(true)
    expect(cp.update(239, 1000, threshold, 0.8).present).toBe(false)
  })
})

describe('PresenceHold', () => {
  it('without a hold, follows each reading at once', () => {
    const hold = new PresenceHold(0)
    expect(hold.update(true, 1_000)).toBe(true)
    expect(hold.current).toEqual({ inBed: true, since: 1_000 })
    expect(hold.update(true, 1_500)).toBe(false)
    expect(hold.update(false, 2_000)).toBe(true)
    expect(hold.current).toEqual({ inBed: false, since: 2_000 })
  })

  it('counts a change once it has lasted the hold, dated from when it began', () => {
    const hold = new PresenceHold(10_000)
    hold.update(true, 0)
    expect(hold.update(false, 1_000)).toBe(false)
    expect(hold.update(false, 10_999)).toBe(false)
    expect(hold.current.inBed).toBe(true)
    expect(hold.update(false, 11_000)).toBe(true)
    expect(hold.current).toEqual({ inBed: false, since: 1_000 })
  })

  it('a reversal within the hold cancels the change', () => {
    const hold = new PresenceHold(10_000)
    hold.update(true, 0)
    hold.update(false, 1_000)
    expect(hold.update(true, 5_000)).toBe(false)
    // The next absence starts its own hold.
    hold.update(false, 6_000)
    expect(hold.update(false, 12_000)).toBe(false)
    expect(hold.update(false, 16_000)).toBe(true)
    expect(hold.current.since).toBe(6_000)
  })

  it('reads unknown without a reading, and takes the first reading after it as is', () => {
    const hold = new PresenceHold(10_000)
    expect(hold.update(null, 0)).toBe(false)
    expect(hold.current).toEqual({ inBed: null, since: null })
    expect(hold.update(true, 1_000)).toBe(true)
    expect(hold.update(null, 2_000)).toBe(true)
    expect(hold.current.inBed).toBeNull()
    expect(hold.update(false, 3_000)).toBe(true)
    expect(hold.current).toEqual({ inBed: false, since: 3_000 })
  })

  it('a new hold applies to the next change', () => {
    const hold = new PresenceHold(0)
    hold.update(true, 0)
    hold.setHold(5_000)
    expect(hold.update(false, 1_000)).toBe(false)
    expect(hold.update(false, 6_000)).toBe(true)
  })
})

describe('readPresenceBaselines', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bed-presence-'))
    file = path.join(dir, 'sleep-detector-state.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const state = {
    version: 1,
    left: { baseline: { format: 'capSense', means: { out: 1000, cen: 1500, in: 1700 }, threshold: 300, ref_mean: null } },
    right: { baseline: { format: 'capSense2', means: { A: 10, B: 20, C: 30 }, threshold: 6, ref_mean: 1.2 } },
  }

  it('reads each side\'s baseline from the sleep-detector state file', async () => {
    await writeFile(file, JSON.stringify(state))
    expect(await readPresenceBaselines(file)).toEqual({ left: capSense, right: capSense2 })
  })

  it('has no baseline when the file is missing, stale, unreadable, or of another version', async () => {
    expect(await readPresenceBaselines(file)).toEqual({ left: null, right: null })
    await writeFile(file, JSON.stringify(state))
    const old = (Date.now() - BASELINE_STALE_MS - 60_000) / 1000
    await utimes(file, old, old)
    expect(await readPresenceBaselines(file)).toEqual({ left: null, right: null })
    await writeFile(file, '{not json')
    expect(await readPresenceBaselines(file)).toEqual({ left: null, right: null })
    await writeFile(file, JSON.stringify({ ...state, version: 2 }))
    expect(await readPresenceBaselines(file)).toEqual({ left: null, right: null })
  })

  it('skips a side whose baseline is incomplete', async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      left: { baseline: { format: 'capSense', means: { out: 1000, cen: 1500 }, threshold: 300 } },
      right: { baseline: { format: 'capSense2', means: { A: 10, B: 20, C: 30 }, threshold: 0 } },
    }))
    expect(await readPresenceBaselines(file)).toEqual({ left: null, right: null })
  })

  it('finds the state file next to biometrics.db unless its path is set', () => {
    const env = { ...process.env }
    try {
      delete process.env.SLEEP_DETECTOR_STATE_PATH
      process.env.BIOMETRICS_DATABASE_URL = 'file:/persistent/sleepypod-data/biometrics.db'
      expect(sleepDetectorStatePath()).toBe('/persistent/sleepypod-data/sleep-detector-state.json')
      process.env.SLEEP_DETECTOR_STATE_PATH = '/tmp/state.json'
      expect(sleepDetectorStatePath()).toBe('/tmp/state.json')
    }
    finally {
      process.env = env
    }
  })
})
