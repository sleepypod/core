import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
/** Only the controller service is restarted. Submission is not proof of a new process or recovered hardware. */
export async function submitControllerRestart() {
  if (process.platform !== 'linux') throw new Error('Controller restart is available only on the Pod.')
  await execute('/bin/systemctl', ['--no-block', 'restart', 'sleepypod.service'],
    { timeout: 2000, maxBuffer: 4096, encoding: 'utf8' })
}
