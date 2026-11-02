// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { configHash } from '../../algorithms/canonical'
import { probeShadowBuild } from '../build'
const location = { pythonPath: resolve('modules/piezo-processor/.venv/bin/python'), modulesPath: resolve('modules') }
// Needs the locked piezo-processor venv, which Stryker's sandbox doesn't carry.
it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('probes the exact locked interpreter and requires shadow sources and intact identity', async () => {
  const build = await probeShadowBuild(location)
  expect(build).toEqual(await probeShadowBuild(location))
  expect(build.identity.version).toBe('shadow-python-build-v1')
  expect(build.identity.sources).toHaveProperty('common/biometrics/shadow_process.py')
  expect(build.identity.sources).toHaveProperty('common/biometrics/signal.py')
  const directory = await mkdtemp(join(tmpdir(), 'shadow-build-'))
  try {
    const executable = join(directory, 'probe')
    for (const raw of [{ ...build, hash: '0'.repeat(64) }, { ...build, identity: { ...build.identity, version: 'waveform-python-build-v1' } }]) {
      await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(raw))});`, { mode: 0o700 })
      await expect(probeShadowBuild({ ...location, pythonPath: executable })).rejects.toThrow()
    }
    const missing = structuredClone(build.identity)
    delete missing.sources['common/biometrics/shadow_process.py']
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ hash: configHash(missing), identity: missing }))});`, { mode: 0o700 })
    await expect(probeShadowBuild({ ...location, pythonPath: executable })).rejects.toThrow(/incomplete/)
    await expect(probeShadowBuild({ ...location, pythonPath: join(directory, 'missing') })).rejects.toThrow(/unavailable/)
    const abort = new AbortController()
    abort.abort()
    await expect(probeShadowBuild(location, abort.signal)).rejects.toThrow(/unavailable/)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('packages the host without live service imports and binds its exact bytes', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { loadInstalledShadowHost, inspectInstalledShadowHost } = await import('../installed-host')
  const { readFile } = await import('node:fs/promises')
  const { shadowEngineBuildIdentity } = await import('../build')
  const directory = await mkdtemp(resolve('node_modules/shadow-package-test-'))
  try {
    await promisify(execFile)(process.execPath, ['scripts/build/biometrics-worker.mjs', directory], { timeout: 30000 })
    const path = join(directory, 'shadow-host.cjs')
    const loaded = loadInstalledShadowHost(path), api = loaded.api
    loaded.assertCurrent()
    expect(loadInstalledShadowHost(path).api).toBe(api)
    expect(Object.keys(api).sort()).toEqual(['ShadowStore', 'openProfiledShadowHost', 'prepareShadowPlan', 'readInstalledShadowQualifications', 'runProfiledShadowAttempt',
      'shadowEngineBuildIdentity', 'shadowHostApiVersion', 'shadowPlanSchema', 'shadowStoragePolicySchema'].sort())
    const dependencies = JSON.parse(await readFile(join(directory, 'shadow-host-dependencies.json'), 'utf8')) as string[]
    expect(dependencies).toContain('src/biometrics/algorithms/registry.ts')
    expect(dependencies).toContain('src/streaming/prospectiveFrameTap.ts')
    expect(dependencies.some(path => /src\/(hardware|automation|scheduler|homekit)\//.test(path) || path.endsWith('/piezoStream.ts'))).toBe(false)
    const original = await shadowEngineBuildIdentity(path, location)
    expect((await inspectInstalledShadowHost(path, location)).build).toEqual(original)
    expect(original.identity.hostHash).toBe(loaded.hostHash)
    expect(original.python).toEqual(await probeShadowBuild(location))
    expect(await api.shadowEngineBuildIdentity(path, location)).toEqual(original)
    await writeFile(path, '// changed build\n' + await readFile(path, 'utf8'))
    expect(() => loaded.assertCurrent()).toThrow(/changed/)
    expect(() => loadInstalledShadowHost(path)).toThrow(/changed/)
    const changed = await shadowEngineBuildIdentity(path, location)
    expect(changed.hash).not.toBe(original.hash)
    expect(changed.python.hash).toBe(original.python.hash)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
