import { expect, it } from 'vitest'
import { bedCareSchema, careCheckCurrent } from '@/src/bed-care/contract'
import { health } from '../handlers/health'

it('practice care uses the real projection with current synthetic observations', async () => {
  if (!health.care) throw new Error('Missing care demo handler')
  const report = bedCareSchema.parse(await health.care({}))
  expect(report.checks).toHaveLength(5)
  expect(report.checks[0].state).toBe('checked')
  expect(report.checks.every(check => careCheckCurrent(check, report.generatedAt))).toBe(true)
  expect(report.checks[1].detail).toContain('Protection is enabled')
  expect(report.checks[4].detail).toContain('not verified')
})
