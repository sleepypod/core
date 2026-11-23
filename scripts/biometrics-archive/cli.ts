import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { curlFetch } from './curl-fetch'
import { pull, type PullOptions } from './pull'

const usage = `Usage:
  pull --pod HOST[:PORT] --dest DIR [--since ISO] [--until ISO] [--no-raw] [--curl]
Pulls the pod's analysis export (GET /api/biometrics/analysis-export) into DIR/<pod id>/.
Without --since, continues from the last successful pull (first run: the last 14 days).
--curl downloads through /usr/bin/curl, for macOS hosts whose Local Network privacy blocks node (EHOSTUNREACH).`

const instant = (flag: string) => z.string().refine(value => Number.isFinite(Date.parse(value)), `${flag} must be an ISO 8601 timestamp`)
  .transform(value => Date.parse(value))

const pullArgsSchema = z.object({
  pod: z.string({ error: '--pod is required' }).regex(/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/, '--pod is HOST or HOST:PORT'),
  dest: z.string({ error: '--dest is required' }).min(1),
  since: instant('--since').optional(),
  until: instant('--until').optional(),
  noRaw: z.boolean(),
  curl: z.boolean(),
}).refine(args => args.since === undefined || args.until === undefined || args.since < args.until, { message: '--since must be before --until' })

function options(args: string[]) {
  const values: Record<string, string | boolean> = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--no-raw') values.noRaw = true
    else if (arg === '--curl') values.curl = true
    else if (['--pod', '--dest', '--since', '--until'].includes(arg) && index + 1 < args.length) values[arg.slice(2)] = args[++index]
    else throw new Error(`Unknown or incomplete option: ${arg}\n${usage}`)
  }
  return { noRaw: false, curl: false, ...values }
}

export async function runArchiveCli(args: string[], overrides: Partial<PullOptions> = {}) {
  const [command, ...rest] = args
  if (command !== 'pull') throw new Error(usage)
  const parsed = pullArgsSchema.safeParse(options(rest))
  if (!parsed.success) throw new Error(`${parsed.error.issues.map(issue => issue.message).join('; ')}\n${usage}`)
  const { pod, dest, since, until, noRaw, curl } = parsed.data
  const records = await pull({ pod, dest: resolve(dest), sinceMs: since, untilMs: until, includeRaw: !noRaw, ...(curl ? { fetch: curlFetch() } : {}),
    log: line => process.stderr.write(`${line}\n`), ...overrides })
  process.stdout.write(`${JSON.stringify({ pulls: records.length, cursor: records.at(-1)?.cursor.end ?? null,
    newRaw: records.reduce((total, record) => total + record.raw.new, 0),
    rowsAdded: records.reduce((total, record) => total + record.rows.inserted + record.rows.reassigned, 0),
    conflicts: records.reduce((total, record) => total + record.rows.conflicts, 0) })}\n`)
  return records
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runArchiveCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
