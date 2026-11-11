import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

const maximumCommandTime = 10_000

export function fixtureCommand(command: string, arguments_: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>
export function fixtureCommand(command: string, arguments_: string[], options?: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>
/** Bound real fixture processes and fail on launch/timeout errors, including expected-failure cases. */
export function fixtureCommand(command: string, arguments_: string[], options: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  const timeout = Math.min(options.timeout ?? maximumCommandTime, maximumCommandTime)
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('Fixture command timeout must be positive')
  const result = spawnSync(command, arguments_, { ...options, timeout, killSignal: 'SIGKILL' })
  if (result.error) throw result.error
  return result
}
