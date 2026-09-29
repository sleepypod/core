import { describe, expect, it } from 'vitest'
import {
  dailyGrowth, daysToSteady, isUnprunedGrowth, fmtRetention, fmtRowTime, growthKind, isStalled, migrationNote, outlookSentence, projectOutlook,
  sizeAfter, stripCells, toCsv, type TableLike,
} from '../databasesLogic'

const MB = 1024 * 1024
const table = (over: Partial<TableLike>): TableLike => ({
  name: 't', rows: 1000, bytes: 10 * MB, rows24h: 100, lastWriteAt: null, hourly: new Array(24).fill(0), retention: null, ...over,
})

describe('growth', () => {
  it('derives bytes per day from the last 24 h of rows', () => {
    expect(dailyGrowth(table({}))).toBe(MB)
    expect(dailyGrowth(table({ rows: 0 }))).toBe(0)
  })

  it('ignores tables whose time column only records updates', () => {
    expect(dailyGrowth(table({ timeColumn: 'last_updated' }))).toBe(0)
    expect(isUnprunedGrowth(table({ timeColumn: 'last_updated' }))).toBe(false)
    expect(isUnprunedGrowth(table({ timeColumn: 'fired_at' }))).toBe(true)
    expect(isUnprunedGrowth(table({ rows24h: 0 }))).toBe(false)
  })

  it('grows an unpruned table forever and levels a retained one off', () => {
    expect(sizeAfter(table({}), 30)).toBe(40 * MB)
    const retained = table({ retention: { days: 20, by: 'x' } })
    expect(sizeAfter(retained, 5)).toBe(15 * MB)
    expect(sizeAfter(retained, 100)).toBe(20 * MB)
    expect(daysToSteady(retained)).toBe(10)
  })

  it('shrinks a retained table that is over its steady size', () => {
    const t = table({ bytes: 40 * MB, rows24h: 25, retention: { days: 10, by: 'x' } })
    expect(sizeAfter(t, 10)).toBe(10 * MB)
    expect(daysToSteady(t)).toBeNull()
  })

  it('classifies tables', () => {
    expect(growthKind(table({}))).toBe('growing')
    expect(growthKind(table({ rows24h: 0 }))).toBe('static')
    expect(growthKind(table({ retention: { days: 2, by: 'x' } }))).toBe('retained')
  })
})

describe('projectOutlook', () => {
  it('finds when the disk fills and names what isn’t pruned', () => {
    const o = projectOutlook([table({ name: 'automation_runs' }), table({ name: 'vitals', retention: { days: 90, by: 'x' } })], 100 * MB)
    expect(o.fillDays).toBe(50) // 100 MB free; both grow 1 MB/day until vitals levels off at 90 MB
    expect(o.growers.map(g => g.name)).toEqual(['automation_runs'])
    expect(o.samples[0].growing + o.samples[0].retained).toBe(20 * MB)
    const text = outlookSentence(o, Date.UTC(2026, 8, 28), b => `${b}`)
    expect(text).toContain('the disk fills around')
    expect(text).toContain('automation_runs isn’t pruned')
  })

  it('says the disk has room when nothing fills it within ten years', () => {
    const o = projectOutlook([table({ rows24h: 0 })], 1e12)
    expect(o.fillDays).toBeNull()
    expect(outlookSentence(o, 0, String)).toContain('stay about this size')
  })
})

describe('write strips', () => {
  it('hatches occupied hours where a vitals table wrote nothing', () => {
    const hourly = new Array(24).fill(0)
    hourly[20] = 60
    const cells = stripCells({ name: 'vitals', hourly }, new Set([20, 21, 22]))
    expect(cells[20]).toBe('write')
    expect(cells[21]).toBe('missing')
    expect(cells[5]).toBe('idle')
    expect(isStalled(cells)).toBe(true)
    expect(stripCells({ name: 'bed_temp', hourly }, new Set([21]))[21]).toBe('idle')
  })

  it('is not stalled when the newest cell wrote', () => {
    expect(isStalled(['missing', 'write', 'idle'])).toBe(false)
  })
})

describe('wording', () => {
  it('flags migration mismatches', () => {
    expect(migrationNote({ applied: 17, known: 17, appliedTag: '0016_x', latestTag: '0016_x' })).toEqual({ text: '0016_x', warn: false })
    expect(migrationNote({ applied: 19, known: 17, appliedTag: null, latestTag: '0016_x' })).toEqual({ text: '2 applied by another build', warn: true })
    expect(migrationNote({ applied: 15, known: 17, appliedTag: null, latestTag: null }).text).toBe('2 pending')
  })

  it('formats retention, row times and CSV', () => {
    expect(fmtRetention(90)).toBe('90 d')
    expect(fmtRetention(2)).toBe('48 h')
    expect(fmtRetention(1.5)).toBe('36 h')
    expect(fmtRowTime(new Date(2026, 8, 28, 15, 5, 23).getTime() / 1000, false)).toBe('2026-09-28 15:05:23')
    expect(toCsv(['a', 'b'], [[1, 'x,y'], [null, 'q"']])).toBe('a,b\n1,"x,y"\n,"q"""')
  })
})
