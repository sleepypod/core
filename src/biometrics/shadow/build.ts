import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { z } from 'zod'
import { workerBuildHash } from '../backtest/child'
import { configHash } from '../algorithms/canonical'
import { waveformPythonBuildSchema } from '../backtest/waveform-build'

const dependencyPaths = z.object({ record: z.string().min(1).max(4096), wheel: z.string().min(1).max(4096) }).strict()
export const shadowPythonBuildSchema = waveformPythonBuildSchema.extend({
  dependencyFiles: z.object({ numpy: dependencyPaths, scipy: dependencyPaths }).strict(), identity: waveformPythonBuildSchema.shape.identity.extend({
    version: z.literal('shadow-python-build-v1'),
  }).refine(identity => ['live_input.py', 'mechanical.py', 'shadow_build.py', 'shadow.py', 'shadow_worker.py', 'shadow_process.py'].every(name =>
    identity.sources[`common/biometrics/${name}`] !== undefined), 'Shadow source identity incomplete') })

/** Fixed shipped probe, exact worker interpreter, bounded output/deadline. Never
 * accepts a module name, shell command or source code from a request. */
export async function probeShadowBuild(location: { pythonPath: string, modulesPath: string }, signal?: AbortSignal) {
  const { stdout } = await promisify(execFile)(location.pythonPath, ['-B', '-m', 'common.biometrics.shadow_build'], {
    cwd: tmpdir(), env: { NODE_ENV: 'production', PYTHONPATH: location.modulesPath, LANG: 'C.UTF-8', TZ: 'UTC',
      OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1' },
    encoding: 'utf8', maxBuffer: 65536, timeout: 10000, killSignal: 'SIGKILL', signal,
  }).catch(() => { throw new Error('Shadow build identity is unavailable') })
  const result = shadowPythonBuildSchema.parse(JSON.parse(stdout))
  if (configHash(result.identity) !== result.hash) throw new Error('Shadow build identity integrity mismatch')
  return result
}

/** Bind the complete packaged host graph and prospective Python fingerprint.
 * The service must execute this bundle, not hash an unrelated unused artifact. */
export async function shadowEngineBuildIdentity(hostPath: string, location: { pythonPath: string, modulesPath: string }, signal?: AbortSignal) {
  const [hostHash, python] = await Promise.all([workerBuildHash(hostPath), probeShadowBuild(location, signal)])
  const identity = { version: 'shadow-engine-build-v1', hostHash, pythonHash: python.hash,
    node: { version: process.version, platform: process.platform, arch: process.arch, icu: process.versions.icu ?? null } }
  return { hash: configHash(identity), identity, python }
}
