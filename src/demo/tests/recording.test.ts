import { afterEach, expect, it, vi } from 'vitest'
import { health } from '../handlers/health'

afterEach(() => vi.restoreAllMocks())

it('evaluates demo recording sources after their observation clocks', async () => {
  let clock = Date.UTC(2026, 10, 10, 22)
  vi.spyOn(Date, 'now').mockImplementation(() => clock++)
  if (!health.recording) throw new Error('The demo recording handler must exist')
  const recording = await health.recording({})
  expect(recording.state).toBe('ready')
  expect(recording.checks).toHaveLength(8)
  expect(recording.checks.every(check => check.observedAt !== null && check.observedAt <= recording.generatedAt)).toBe(true)
  expect(recording.checks.find(check => check.id === 'presence-history')).toMatchObject({ state: 'ok' })
})

it('keeps the demo recording snapshot current when composing bed care', async () => {
  let clock = Date.UTC(2026, 10, 10, 22)
  vi.spyOn(Date, 'now').mockImplementation(() => clock++)
  if (!health.care) throw new Error('The demo care handler must exist')
  const care = await health.care({})
  expect(care.checks.find(check => check.id === 'recording')).toMatchObject({ state: 'checked' })
  expect(care.checks.find(check => check.id === 'storage')).toMatchObject({ state: 'checked' })
})
