// @vitest-environment node
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { probeShadowBuild, shadowPythonBuildSchema } from '../build'
import { guardShadowPythonInstallation } from '../python-installation'
const directories: string[] = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
async function setup() {
  const original = { pythonPath: resolve('modules/piezo-processor/.venv/bin/python'), modulesPath: resolve('modules') }
  const build = await probeShadowBuild(original)
  const root = mkdtempSync(join(tmpdir(), 'python-installation-'))
  directories.push(root)
  for (const relative of Object.keys(build.identity.sources)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(join(original.modulesPath, relative), path)
  }
  for (const name of ['numpy', 'scipy'] as const) {
    for (const kind of ['record', 'wheel'] as const) {
      const path = join(root, `${name}-${kind}`)
      copyFileSync(build.dependencyFiles[name][kind], path)
      build.dependencyFiles[name][kind] = path
    }
  }
  const pythonPath = join(root, 'python')
  symlinkSync(original.pythonPath, pythonPath)
  const location = { pythonPath, modulesPath: root }
  return { build, location, source: join(root, 'common/biometrics/shadow.py') }
}
it('validates real source and wheel metadata against the probe, then detects source replacement', async () => {
  const { build, location, source } = await setup()
  const guard = guardShadowPythonInstallation(location, build)
  guard()
  renameSync(source, source + '.old')
  copyFileSync(source + '.old', source)
  expect(guard).toThrow(/changed/)
})
it('refuses source content changed after probing', async () => {
  const { build, location, source } = await setup()
  writeFileSync(source, '# changed')
  expect(() => guardShadowPythonInstallation(location, build)).toThrow(/differs from probe/)
})
it('detects metadata mutation and executable link replacement', async () => {
  const { build, location } = await setup()
  const guard = guardShadowPythonInstallation(location, build)
  writeFileSync(build.dependencyFiles.numpy.wheel, 'changed')
  expect(guard).toThrow(/changed/)
  const other = await setup()
  const executableGuard = guardShadowPythonInstallation(other.location, other.build)
  rmSync(other.location.pythonPath)
  symlinkSync(process.execPath, other.location.pythonPath)
  expect(executableGuard).toThrow(/changed/)
})
it('refuses malformed build hashes and non-absolute dependency paths', async () => {
  const { build, location } = await setup()
  expect(() => guardShadowPythonInstallation(location, { ...build, hash: 'a'.repeat(64) })).toThrow(/integrity/)
  build.dependencyFiles.numpy.record = 'relative/RECORD'
  expect(() => guardShadowPythonInstallation(location, build)).toThrow(/absolute/)
})

it('refuses a build identity without the shared live timestamp and continuity boundary', async () => {
  const { build } = await setup()
  delete build.identity.sources['common/biometrics/live_input.py']
  expect(() => shadowPythonBuildSchema.parse(build)).toThrow(/source identity incomplete/)
})
