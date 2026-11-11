import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { controllerGenerationSchema, controllerGenerationInstantSchema as instant,
  controllerInvocationIdSchema as invocation, type ControllerGeneration } from '@/src/lib/controllerGenerationContract'
export { controllerGenerationSchema, type ControllerGeneration } from '@/src/lib/controllerGenerationContract'

const properties = ['MainPID', 'ActiveState', 'SubState', 'InvocationID'] as const
const argumentsForShow = ['show', 'sleepypod.service', '--no-pager', `--property=${properties.join(',')}`]
const execute = promisify(execFile)
const unavailable = () => new Error('The active controller service generation could not be verified.')

interface Dependencies {
  platform: string
  pid: number
  invocationId: string | undefined
  now: () => number
  show: () => Promise<string>
  read: (path: string) => Promise<string>
}

function parseProperties(text: string): Record<string, string> {
  if (text.length > 4096) throw unavailable()
  const result: Record<string, string> = {}
  for (const line of text.trimEnd().split('\n')) {
    const separator = line.indexOf('=')
    if (separator < 1) throw unavailable()
    const key = line.slice(0, separator)
    if (!properties.includes(key as typeof properties[number]) || Object.hasOwn(result, key)) throw unavailable()
    result[key] = line.slice(separator + 1)
  }
  if (Object.keys(result).length !== properties.length) throw unavailable()
  return result
}

function processStartTicks(text: string, pid: number): string {
  if (text.length > 16_384 || !text.startsWith(`${pid} (`)) throw unavailable()
  // /proc comm may contain spaces and parentheses. Fields begin after its last closing parenthesis.
  const end = text.lastIndexOf(') ')
  if (end < 0) throw unavailable()
  const fields = text.slice(end + 2).trim().split(/\s+/)
  const ticks = fields[19] // stat field 22; the first remaining field is field 3 (state).
  if (!ticks || !/^[1-9][0-9]{0,19}$/.test(ticks) || !['R', 'S', 'D', 'I'].includes(fields[0] ?? '')) throw unavailable()
  return ticks
}

/** Read-only Linux proof. A random JS run ID or a changed environment variable is not a service restart. */
export async function readControllerGeneration(overrides: Partial<Dependencies> = {}): Promise<ControllerGeneration> {
  const dependencies: Dependencies = {
    platform: process.platform, pid: process.pid, invocationId: process.env.INVOCATION_ID,
    now: Date.now,
    show: async () => (await execute('/bin/systemctl', argumentsForShow, { timeout: 2000, maxBuffer: 4096, encoding: 'utf8' })).stdout,
    read: path => readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(1000) }),
    ...overrides,
  }
  if (dependencies.platform !== 'linux' || !invocation.safeParse(dependencies.invocationId).success) throw unavailable()
  const startedAt = instant.parse(dependencies.now())
  const first = parseProperties(await dependencies.show())
  if (first.ActiveState !== 'active' || first.SubState !== 'running'
    || first.MainPID !== String(dependencies.pid) || first.InvocationID !== dependencies.invocationId) throw unavailable()
  const [stat, boot] = await Promise.all([
    dependencies.read(`/proc/${dependencies.pid}/stat`), dependencies.read('/proc/sys/kernel/random/boot_id'),
  ])
  const second = parseProperties(await dependencies.show())
  if (properties.some(key => first[key] !== second[key])) throw unavailable()
  const observedAt = instant.parse(dependencies.now())
  if (observedAt < startedAt || observedAt - startedAt > 5000 || boot.length > 64) throw unavailable()
  return controllerGenerationSchema.parse({ version: 1, invocationId: second.InvocationID, bootId: boot.trim(),
    pid: dependencies.pid, startTicks: processStartTicks(stat, dependencies.pid), observedAt })
}

/** Recovery needs both a new service invocation and a new kernel process identity, observed freshly. */
export function isNewControllerGeneration(previous: unknown, current: unknown, now = Date.now()): boolean {
  const before = controllerGenerationSchema.safeParse(previous)
  const after = controllerGenerationSchema.safeParse(current)
  if (!before.success || !after.success || !instant.safeParse(now).success) return false
  return before.data.observedAt <= after.data.observedAt && after.data.observedAt <= now
    && now - after.data.observedAt <= 5000 && before.data.invocationId !== after.data.invocationId
    && (before.data.bootId.toLowerCase() !== after.data.bootId.toLowerCase()
      || BigInt(after.data.startTicks) > BigInt(before.data.startTicks))
}
