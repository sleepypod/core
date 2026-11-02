// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { probeWaveformBuild, waveformEvaluatorBuildIdentity } from '../waveform-build'
let directory: string
const location = { pythonPath: resolve('modules/piezo-processor/.venv/bin/python'), modulesPath: resolve('modules') }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'waveform-build-'))
})
afterEach(() => rm(directory, { recursive: true, force: true }))
// Needs the locked piezo-processor venv, which Stryker's sandbox doesn't carry.
it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('verifies a real Python identity and binds both shipped Node bundles', async () => {
  const coordinator = join(directory, 'coordinator.cjs'), worker = join(directory, 'worker.cjs')
  await writeFile(coordinator, 'orchestration-v1')
  await writeFile(worker, 'scoring-v1')
  const first = await waveformEvaluatorBuildIdentity(coordinator, worker, location)
  expect(first.python).toEqual(await probeWaveformBuild(location))
  expect(first.python.identity.sources).toHaveProperty('common/biometrics/replay_worker.py')
  expect(first).toEqual(await waveformEvaluatorBuildIdentity(coordinator, worker, location))
  await writeFile(coordinator, 'orchestration-v2')
  const second = await waveformEvaluatorBuildIdentity(coordinator, worker, location)
  expect(second.hash).not.toBe(first.hash)
  expect(second.python.hash).toBe(first.python.hash)
  await writeFile(worker, 'scoring-v2')
  expect((await waveformEvaluatorBuildIdentity(coordinator, worker, location)).hash).not.toBe(second.hash)
})
it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('rejects missing interpreters, invalid output and forged build hashes', async () => {
  await expect(probeWaveformBuild({ ...location, pythonPath: join(directory, 'missing') })).rejects.toThrow('unavailable')
  const fixture = join(directory, 'fixture')
  await writeFile(fixture, `#!${process.execPath}\nprocess.stdout.write('{}');`, { mode: 0o700 })
  await expect(probeWaveformBuild({ ...location, pythonPath: fixture })).rejects.toThrow()
  const build = await probeWaveformBuild(location)
  await writeFile(fixture, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ ...build, hash: '0'.repeat(64) }))});`, { mode: 0o700 })
  await expect(probeWaveformBuild({ ...location, pythonPath: fixture })).rejects.toThrow('integrity mismatch')
  const controller = new AbortController()
  controller.abort()
  await expect(probeWaveformBuild(location, controller.signal)).rejects.toThrow('unavailable')
})
