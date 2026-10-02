import { describe, expect, it } from 'vitest'
import { condenseChecks, fitMetric, mergeRuns, nodeFromSlug, nodeSlug } from '../healthLogic'

describe('node slugs', () => {
  it('names nodes in the URL by label and reads them back', () => {
    expect(nodeSlug('out-live')).toBe('live-stream')
    expect(nodeSlug('dac')).toBe('dac-socket')
    expect(nodeFromSlug('live-stream')).toBe('out-live')
    expect(nodeFromSlug('piezo-processor')).toBe('piezo-processor')
    expect(nodeFromSlug('out-vitals')).toBe('out-vitals')
    expect(nodeFromSlug('nope')).toBeNull()
    expect(nodeFromSlug(null)).toBeNull()
  })
})

describe('fitMetric', () => {
  it('keeps metrics that fit a node and cuts longer ones with an ellipsis', () => {
    expect(fitMetric('WS :3001 · 2 viewers')).toBe('WS :3001 · 2 viewers')
    expect(fitMetric('L holding · R holding')).toBe('L holding · R holding')
    expect(fitMetric('L delivering · R delivering')).toBe('L delivering · R del…')
  })
})

describe('mergeRuns', () => {
  it('takes the worst status per stretch and joins neighbours that agree', () => {
    expect(mergeRuns([
      [{ status: 'ok', start: 0, end: 10 }],
      [{ status: 'idle', start: 0, end: 4 }, { status: 'stale', start: 4, end: 6 }, { status: 'idle', start: 6, end: 10 }],
    ])).toEqual([
      { status: 'ok', start: 0, end: 4 },
      { status: 'stale', start: 4, end: 6 },
      { status: 'ok', start: 6, end: 10 },
    ])
  })

  it('leaves time no check recorded empty', () => {
    expect(mergeRuns([[{ status: 'ok', start: 0, end: 2 }, { status: 'ok', start: 5, end: 8 }]])).toEqual([
      { status: 'ok', start: 0, end: 2 },
      { status: 'ok', start: 5, end: 8 },
    ])
  })
})

describe('condenseChecks', () => {
  const ok = [{ status: 'ok' as const, start: 0, end: 10 }]
  const check = (id: 'dac' | 'database' | 'scheduler', incidents: number) => ({ id, label: id, runs: ok, healthyShare: 1, incidents })

  it('keeps a lone quiet check as its own row rather than "1 other checks"', () => {
    expect(condenseChecks([check('dac', 2), check('database', 0)], false).map(r => r.label)).toEqual(['dac', 'database'])
  })

  it('lists every check on its own when expanded', () => {
    expect(condenseChecks([check('dac', 0), check('database', 0), check('scheduler', 0)], true)).toHaveLength(3)
    expect(condenseChecks([check('dac', 0), check('database', 0), check('scheduler', 0)], false)).toMatchObject([{ key: 'rest', label: '3 other checks', rest: { checks: 3 } }])
  })
})
