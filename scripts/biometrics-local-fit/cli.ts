import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractBundle, verifyBundle } from './bundle'
import { candidateFileSchema, defaultPythonLocation, fitCandidates, LOCAL_SPLITS, type Candidate, type LocalSplit } from './fit'
import { DEFAULT_GRID, expandGrid } from './grid'
import { compareWithPod, parseLocalReport, rankCandidates, rankingMarkdown } from './report'

const usage = `Usage:
  verify BUNDLE
  fit BUNDLE CANDIDATES.json OUTPUT_DIR [--jobs N] [--splits tuning,validation] [--include-holdout] [--save-readings] [--min-coverage 0.75] [--protocol FILE] [--python PATH]
  sweep BUNDLE GRID.json|default OUTPUT_DIR [same options as fit]
  parity OUTPUT_DIR POD_RESULT.json [POD_RESULT.json ...]
BUNDLE is the tar from GET /api/biometric-tuning/datasets/{id}/export, or a directory extracted from it.`

function options(args: string[]) {
  const values: Record<string, string> = {}
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--include-holdout' || args[index] === '--save-readings') values[args[index].slice(2)] = 'true'
    else if (args[index].startsWith('--')) values[args[index].slice(2)] = args[++index] ?? ''
    else positional.push(args[index])
  }
  return { values, positional }
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function openBundle(path: string, outputDirectory: string) {
  if ((await stat(path)).isDirectory()) return verifyBundle(path)
  const destination = join(outputDirectory, 'bundle')
  if (resolve(path) === resolve(destination) || resolve(path).startsWith(`${resolve(destination)}/`)) {
    throw new Error(`The bundle cannot live inside ${destination}: that directory is replaced by the extracted copy`)
  }
  await rm(destination, { recursive: true, force: true })
  await extractBundle(path, destination)
  return verifyBundle(destination)
}

async function fit(bundlePath: string, candidates: Candidate[], outputDirectory: string, flags: Record<string, string>) {
  // Check flags before extracting a bundle or replaying anything.
  const jobs = flags.jobs === undefined ? undefined : Number(flags.jobs)
  if (jobs !== undefined && !(Number.isSafeInteger(jobs) && jobs >= 1)) throw new Error('--jobs is a positive whole number of parallel replays')
  const minimumCoverage = flags['min-coverage'] === undefined ? undefined : Number(flags['min-coverage'])
  if (minimumCoverage !== undefined && !(Number.isFinite(minimumCoverage) && minimumCoverage >= 0 && minimumCoverage <= 1)) {
    throw new Error('--min-coverage is a fraction from 0 to 1, for example 0.75')
  }
  await mkdir(outputDirectory, { recursive: true })
  const bundle = await openBundle(bundlePath, outputDirectory)
  const includeHoldout = flags['include-holdout'] === 'true'
  const splits = (flags.splits?.split(',') ?? [...LOCAL_SPLITS, ...(includeHoldout ? ['holdout'] : [])]) as LocalSplit[]
  const started = performance.now()
  const result = await fitCandidates({ bundle, candidates, outputDirectory, splits, includeHoldout,
    readingsDirectory: flags['save-readings'] === 'true' ? join(outputDirectory, 'readings') : undefined,
    jobs,
    protocol: flags.protocol ? await readJson(flags.protocol) as never : undefined,
    python: flags.python ? defaultPythonLocation(flags.python) : undefined,
    onProgress: (done, total, item) => process.stderr.write(`[${done}/${total}] ${item.cohortId} ${item.candidateIds.join(',') || '(baseline)'} ${(item.wallMs / 1000).toFixed(1)}s\n`) })
  for (const report of result.reports) {
    await mkdir(join(outputDirectory, report.candidate.id), { recursive: true })
    await writeFile(join(outputDirectory, report.candidate.id, `${report.split}.json`), `${JSON.stringify(report)}\n`)
  }
  const ranking = rankCandidates(result.reports, minimumCoverage)
  await writeFile(join(outputDirectory, 'ranking.json'), `${JSON.stringify(ranking, null, 2)}\n`)
  await writeFile(join(outputDirectory, 'ranking.md'), rankingMarkdown(ranking))
  const totalWallMs = performance.now() - started
  await writeFile(join(outputDirectory, 'run.json'), `${JSON.stringify({ version: 'biometrics-local-fit-run-v1', label: 'exploratory-local',
    dataset: bundle.index.dataset, splits, candidates: ranking.rows.length, workItems: result.workItems, jobs: result.jobs,
    replayWallMs: result.replayWallMs, totalWallMs, pythonBuild: { hash: result.build.hash, sourcesHash: result.build.sourcesHash, identity: result.build.identity } }, null, 2)}\n`)
  await rm(join(outputDirectory, 'work'), { recursive: true, force: true })
  process.stdout.write(rankingMarkdown(ranking))
  process.stdout.write(`\n${ranking.rows.length} candidates, ${result.workItems} replays on ${result.jobs} workers in ${(totalWallMs / 60000).toFixed(1)} min\n`)
}

export async function runLocalFitCli(args: string[]) {
  const [command, ...rest] = args
  const { values, positional } = options(rest)
  if (command === 'verify' && positional.length === 1) {
    const path = positional[0]
    let bundle
    if ((await stat(path)).isDirectory()) bundle = await verifyBundle(path)
    else {
      const directory = `${path}.verify-${process.pid}`
      try {
        bundle = await verifyBundle(await extractBundle(path, directory))
      }
      finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    process.stdout.write(`${JSON.stringify({ verified: true, dataset: bundle.index.dataset, files: bundle.index.files.length })}\n`)
    return
  }
  if (command === 'fit' && positional.length === 3) {
    return fit(positional[0], candidateFileSchema.parse(await readJson(positional[1])), positional[2], values)
  }
  if (command === 'sweep' && positional.length === 3) {
    const grid = positional[1] === 'default' ? DEFAULT_GRID : await readJson(positional[1])
    return fit(positional[0], expandGrid(grid), positional[2], values)
  }
  if (command === 'parity' && positional.length >= 2) {
    const defaults = await Promise.all(LOCAL_SPLITS.map(split => readJson(join(positional[0], 'defaults', `${split}.json`)).then(parseLocalReport).catch(() => null)))
    const parity = compareWithPod(defaults.filter(row => row !== null), await Promise.all(positional.slice(1).map(readJson)))
    await writeFile(join(positional[0], 'parity.json'), `${JSON.stringify(parity, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(parity, null, 2)}\n`)
    if (!parity.allWithinTolerance) process.exitCode = 2
    return
  }
  throw new Error(usage)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalFitCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
