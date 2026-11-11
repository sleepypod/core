import { expect, it } from 'vitest'
import { nightTemperatureSegments } from '../nightExplanationModel'

it('does not draw across missing samples, nulls, reordered clocks or a powered-off target', () => {
  const rows = [
    { id: 1, at: 1_000, powered: true, targetF: 70, reportedF: 72 },
    { id: 2, at: 61_000, powered: true, targetF: 70, reportedF: 71 },
    { id: 3, at: 181_000, powered: true, targetF: 70, reportedF: null },
    { id: 4, at: 241_000, powered: false, targetF: 70, reportedF: 70 },
    { id: 5, at: 301_000, powered: true, targetF: 69, reportedF: 70 },
    { id: 6, at: 301_000, powered: true, targetF: 69, reportedF: 70 },
  ]
  expect(nightTemperatureSegments(rows, 'reportedF').map(segment => segment.map(point => point.at)))
    .toEqual([[1_000, 61_000], [241_000, 301_000], [301_000]])
  expect(nightTemperatureSegments(rows, 'targetF').map(segment => segment.map(point => point.at)))
    .toEqual([[1_000, 61_000], [181_000], [301_000], [301_000]])
})
