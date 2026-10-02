import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

/** Inspect this Pod's firmware installation, never infer NATS from its model.
 * A service can be temporarily down at boot; its unit or JetStream storage
 * remains evidence that we should wait. Unknown systems keep the grace probe. */
export async function discoverSensorSource(): Promise<'raw' | 'nats' | 'unknown'> {
  const [storage, service] = await Promise.all([
    stat('/persistent/jetstream').then(info => info.isDirectory()).catch((error: NodeJS.ErrnoException) => {
      return error.code === 'ENOENT' ? false : null
    }),
    runFile('systemctl', ['show', 'nats-server.service', '--property=LoadState', '--value'], { timeout: 2_000 })
      .then(({ stdout }) => {
        const value = stdout.trim()
        return value === 'not-found' ? false : value === 'loaded' || value === 'masked' ? true : null
      }).catch((error: unknown) => {
        console.warn('[sensorStream] NATS installation probe unavailable:', error instanceof Error ? error.message : String(error))
        return null
      }),
  ])
  if (storage || service) return 'nats'
  if (storage === false && service === false) return 'raw'
  return 'unknown'
}
