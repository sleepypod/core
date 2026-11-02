// @vitest-environment node
import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import workerBuild from '../biometrics/worker-build.json'
import { sha256 } from '@noble/hashes/sha2.js'
import { evaluateDemoBacktest } from '../biometrics/evaluator'
import { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
import { backtestFixture } from '@/src/biometrics/backtest/tests/fixtures/backtest'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { createNightUncertainty } from '@/src/biometrics/backtest/uncertainty-core'
import { nightUncertainty } from '@/src/biometrics/backtest/uncertainty'
it('produces exactly the production report and rejects altered retained input', () => {
  const input = backtestFixture()
  expect(evaluateDemoBacktest(input)).toEqual(evaluateBacktest(input))
  const protocol = { ...input.job.protocol, mode: 'comparison' as const }
  const comparison = { ...input, job: { ...input.job, protocol, protocolHash: configHash(protocol) } }
  expect(evaluateDemoBacktest(comparison)).toEqual(evaluateBacktest(comparison))
  input.dataset.snapshot.sessions[0].vitals[0].heartRate = 80
  expect(() => evaluateDemoBacktest(input)).toThrow('integrity mismatch')
})
it('preserves the seeded whole-night uncertainty stream across browser and native hashes', () => {
  const browser = createNightUncertainty(text => sha256(new TextEncoder().encode(text)))
  const nights = Array.from({ length: 12 }, (_, i) => ({ cohortId: String(i).padStart(2, '0'), difference: ((i * 7) % 11 - 5) / 10 }))
  const policy = { version: 'paired-night-percentile-v1' as const, seed: 'fixture', resamples: 200, minimumNights: 3 }
  expect(browser(nights, policy)).toEqual(nightUncertainty(nights, policy))
  expect(browser(nights, policy).interval?.lower).toBeCloseTo(-0.22520833333333334, 14)
})
// Stryker bundles its instrumented sandbox copy, so the pinned build hash can't match there.
it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('bundles a self-contained browser worker without database or hardware dependencies', async () => {
  const bundle = await build({ entryPoints: ['src/demo/biometrics/worker.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true })
  expect(Object.keys(bundle.metafile.inputs).filter(path => /src\/(hardware|db|automation|scheduler|homekit|streaming)\/|better-sqlite3|drizzle-orm/.test(path))).toEqual([])
  expect(createHash('sha256').update(bundle.outputFiles[0].contents).digest('hex')).toBe(workerBuild.buildHash)
  expect(bundle.outputFiles[0].text).not.toMatch(/from ['"]node:/)
})
