import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ModelScorecard, modelScore } from '../ModelScorecard'

afterEach(cleanup)
it('uses held-out nested evaluation when available and supports legacy LONO exports', () => {
  expect(modelScore({ nestedSelection: { kappa: 0.4 }, lono: { kappa: 0.8 } }).kappa).toBe(0.4)
  expect(modelScore({ lono: { kappa: 0.25, nights: 12 } })).toMatchObject({ kappa: 0.25, nights: 12 })
  expect(modelScore({ lono: { kappa: NaN } }).kappa).toBeNull()
  expect(modelScore({ lono: { kappa: 2 } }).kappa).toBeNull()
})
it('does not invent a baseline, per-night bars or stage scores for a summary-only export', () => {
  render(<ModelScorecard metrics={{ lono: { kappa: 0.25, nights: 12 } }} />)
  expect(screen.getByLabelText('κ 0.25')).toBeTruthy()
  expect(screen.getByText('Fair agreement')).toBeTruthy()
  expect(screen.getByText('Rules comparison not included in this model.')).toBeTruthy()
  expect(screen.getAllByText('—')).toHaveLength(4)
  expect(screen.queryByText('rules')).toBeNull()
})
it('separates labels vertically and shows real stage recall when supplied', () => {
  render(<ModelScorecard metrics={{ rules: { kappa: 0.14 }, nestedSelection: { kappa: 0.25, recall: { wake: 0.61, light: 0.48, deep: 0.37, rem: 0.29 } } }} />)
  expect(screen.getByText('rules').className).toContain('top-0')
  expect(screen.getByText('This model').className).toContain('left-2')
  expect(screen.getByText('+0.11 over rules (0.14)')).toBeTruthy()
  expect(screen.getByText('61%')).toBeTruthy()
})

it.each([-2, 2, NaN, Infinity])('omits invalid rules kappa %s from the comparison and scale', (kappa) => {
  render(<ModelScorecard metrics={{ lono: { kappa: 0.25 }, rules: { kappa } }} />)
  expect(screen.queryByText('rules')).toBeNull()
  expect(screen.getByText('Rules comparison not included in this model.')).toBeTruthy()
})
it.each([-1, 0, 1])('accepts valid rules kappa %s', (kappa) => {
  expect(modelScore({ rules: { kappa } }).baseline).toBe(kappa)
})
it('claims held-out evaluation only when a valid score is available', () => {
  const { rerender } = render(<ModelScorecard metrics={undefined} />)
  expect(screen.getByText('Not evaluated')).toBeTruthy()
  expect(screen.queryByText(/Held-out nights/)).toBeNull()
  expect(screen.getByText(/not a measure of clinical accuracy/)).toBeTruthy()
  rerender(<ModelScorecard metrics={{ lono: { kappa: 0 } }} />)
  expect(screen.getByText(/Held-out nights/)).toBeTruthy()
})

it.each([
  [-0.1, 'Below chance agreement'], [0, 'Slight agreement'], [0.5, 'Moderate agreement'],
  [0.7, 'Substantial agreement'], [0.9, 'Near-perfect agreement'],
])('describes kappa %s as %s', (kappa, label) => {
  render(<ModelScorecard metrics={{ lono: { kappa }, rules: { kappa: 1 } }} />)
  expect(screen.getByText(label)).toBeTruthy()
})
