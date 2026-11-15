import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { defaultConfig, manifestHash, resolveConfig, type BiometricConfig, type Override } from '@/src/biometrics/algorithms/registry'
import { rawInspectionSchema } from '@/src/biometrics/backtest/raw-catalog'
import { runRawInspectionChild } from '@/src/biometrics/backtest/raw-inspection-child'
import { runWaveformChild } from '@/src/biometrics/backtest/waveform-child'
import { retainedWaveformInputSchema } from '@/src/biometrics/backtest/waveform-contracts'
import { archivedInspection, archiveNights, archiveRawFiles, nightGenerations, nightWindow, openArchiveDatabase, rawCandidates,
  selectArtifacts, storedParity, storedVitals, warmRawSpans, type RawInspection, type RetainedInput, type Side } from './archive'
import { extractExportRaw } from './export-tar'
import { candidateSchema, defaultPythonLocation, describeLocalBuild, runPool, type PythonLocation } from './fit'

/** Stored-row parity gate: the local-fit `parity` tolerance and the share of minutes that must meet it. */
export const PARITY_TOLERANCE_BPM = 0.1
export const PARITY_MINIMUM_SHARE = 0.95
export const nightSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Nights are YYYY-MM-DD').refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a calendar date')

/** A profile override file: an overrides array, one candidate, or a candidates file holding exactly one. */
const overridesSchema = candidateSchema.shape.overrides
export const profileFileSchema = z.union([overridesSchema, candidateSchema.transform(row => row.overrides),
  z.array(candidateSchema).length(1).transform(rows => rows[0].overrides)])

/** Only a night whose stored rows all came from the replayed config can be held
 * to stored-row parity. The config hash each row's processing run recorded
 * decides: a receipt can say a generation applied while the processor ran
 * defaults. Rows without provenance fall back to one receipted generation. */
export function parityGate(share: number | null, provenance: { storedConfigHashes: Array<{ configHash: string | null }>, generations: number, configHash: string }): ParityGate {
  if (share === null) return 'no_heart_rate_to_compare'
  const hashes = provenance.storedConfigHashes.map(row => row.configHash)
  if (hashes.some(hash => hash !== null)) {
    if (hashes.length > 1) return 'not_gated_mixed_configs'
    if (hashes[0] !== provenance.configHash) return 'not_gated_different_config'
  }
  else if (provenance.generations !== 1) return 'not_gated_mixed_generations'
  return share >= PARITY_MINIMUM_SHARE ? 'pass' : 'fail'
}

export function readingsFileName(night: string, configHash: string) {
  return `${night}-${configHash.slice(0, 12)}.json`
}

async function sha256File(path: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

async function linkOrCopy(from: string, to: string) {
  await link(from, to).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return
    if (!['EXDEV', 'EPERM', 'EROFS', 'ENOTSUP'].includes(error.code ?? '')) throw error
    await copyFile(from, to)
  })
}

async function archiveCursor(archiveDirectory: string) {
  const names = await readdir(join(archiveDirectory, 'pulls')).catch(() => [] as string[])
  let cursor: number | null = null
  for (const name of names.filter(file => file.endsWith('.json'))) {
    const record = z.object({ cursor: z.object({ endMs: z.number() }) }).safeParse(JSON.parse(await readFile(join(archiveDirectory, 'pulls', name), 'utf8')))
    if (record.success) cursor = Math.max(cursor ?? record.data.cursor.endMs, record.data.cursor.endMs)
  }
  return cursor
}

export interface ReplayOptions {
  /** <dest>/<podId> from `pnpm biometrics:archive pull`. */
  archiveDirectory: string
  nights: string[] | 'all'
  side: Side
  config: { source: string, overrides: Override[] }
  outputDirectory: string
  timezone: string
  /** Pre-archive nights: NIGHT → GET /api/export/archive tarball. */
  exports?: Map<string, string>
  jobs?: number
  python?: PythonLocation
  compareStored?: boolean
  onProgress?: (line: string) => void
}

type ParityGate = 'pass' | 'fail' | 'not_gated_mixed_configs' | 'not_gated_different_config' | 'not_gated_mixed_generations' | 'no_heart_rate_to_compare'
interface NightResult {
  readings: number
  wallMs: number
  run: { counts: Record<string, number>, limitations: string[] }
  parity?: ReturnType<typeof storedParity> & { comparedSpans: Array<{ startMs: number, endMs: number }>, gate: ParityGate }
}

interface PlannedNight {
  night: string
  source: 'archive' | 'export'
  exportPath: string | null
  sessionIds: number[]
  window: ReturnType<typeof nightWindow>
  candidates: Array<{ sha256: string, name: string, path: string }>
}

/** Replay archived nights through the unchanged replay_worker with one pinned
 * engine and profile. The archive database supplies each night's in-bed window
 * and recorded occupancy; inspection of the RAW files picks the frames. */
export async function replayArchive(options: ReplayOptions) {
  const started = performance.now()
  const python = options.python ?? defaultPythonLocation()
  const build = await describeLocalBuild(python)
  const { resolved, hash: configHash } = resolveConfig(options.config.overrides)
  const databasePath = join(options.archiveDirectory, 'biometrics.db')
  const db = openArchiveDatabase(databasePath)
  const work = join(options.outputDirectory, 'work')
  const progress = options.onProgress ?? (() => {})
  try {
    const sessionsByNight = archiveNights(db, options.side, options.timezone)
    const exports = options.exports ?? new Map<string, string>()
    const explicit = options.nights !== 'all'
    const requested = [...new Set([...(options.nights === 'all' ? sessionsByNight.keys() : options.nights), ...exports.keys()])].sort()
    const skipped: Array<{ night: string, reason: string }> = []
    const refuse = (night: string, reason: string) => {
      if (explicit || exports.has(night)) throw new Error(`${night}: ${reason}`)
      skipped.push({ night, reason })
    }
    const present = new Set(await readdir(join(options.archiveDirectory, 'raw')).catch(() => [] as string[]))
    const archived = archiveRawFiles(db, options.archiveDirectory).filter(file => present.has(`${file.sha256}.RAW.gz`))
    const planned: PlannedNight[] = []
    for (const night of requested) {
      const sessions = sessionsByNight.get(night)
      if (!sessions) {
        refuse(night, `no ${options.side} sleep record entered during this night (noon to noon, ${options.timezone})`)
        continue
      }
      const window = nightWindow(options.side, sessions)
      const exportPath = exports.get(night) ?? null
      const files = exportPath ? await extractExportRaw(exportPath, join(work, 'export', night)) : archived
      const unique = [...new Map(files.map(file => [file.sha256, file])).values()]
      const candidates = rawCandidates(unique, window)
      if (!candidates.length) {
        refuse(night, exportPath ? 'the export holds no RAW file written during the night' : 'the archive holds no RAW file written during the night')
        continue
      }
      planned.push({ night, source: exportPath ? 'export' : 'archive', exportPath, sessionIds: sessions.map(row => row.id), window, candidates })
    }

    // Inspect each candidate once: this run's cache, then the pod's own catalog row, then the shipped inspection worker.
    const cacheDirectory = join(options.outputDirectory, 'inspections')
    await mkdir(cacheDirectory, { recursive: true })
    const inspections = new Map<string, RawInspection | null>()
    const pending = [...new Map(planned.flatMap(row => row.candidates).map(file => [file.sha256, file])).values()]
    const jobs = Math.max(1, options.jobs ?? availableParallelism())
    let inspected = 0
    await runPool(pending, Array.from({ length: Math.min(jobs, Math.max(1, pending.length)) }, (_, index) => String(index)), async (file, _slot, signal) => {
      const cached = join(cacheDirectory, `${file.sha256}.json`)
      const known = await readFile(cached, 'utf8').then(text => rawInspectionSchema.parse(JSON.parse(text))).catch(() => null) ?? archivedInspection(db, file.sha256)
      if (known && known.artifact.sha256 === file.sha256) {
        inspections.set(file.sha256, known)
      }
      else {
        const directory = join(work, 'inspect', file.sha256)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await linkOrCopy(file.path, join(directory, `${file.sha256}.RAW.gz`))
        const result = await runRawInspectionChild({ pythonPath: python.pythonPath, modulesPath: python.modulesPath, archiveDirectory: directory }, { afterName: null }, { signal })
        await rm(directory, { recursive: true, force: true })
        const inspection = result.status === 'inspected' && result.inspection.artifact.sha256 === file.sha256 ? result.inspection : null
        inspections.set(file.sha256, inspection)
        if (inspection) await writeFile(cached, `${JSON.stringify(inspection)}\n`)
      }
      if (++inspected % 25 === 0 || inspected === pending.length) progress(`inspected ${inspected}/${pending.length} RAW files`)
    })

    const nights: Array<PlannedNight & { input: RetainedInput, excluded: ReturnType<typeof selectArtifacts>['excluded'] }> = []
    for (const row of planned) {
      try {
        const selected = selectArtifacts(row.candidates.map(file => ({ sha256: file.sha256, inspection: inspections.get(file.sha256) ?? null })), row.window)
        const input = retainedWaveformInputSchema.parse({ version: 'retained-waveform-input-v1', retained_start_ms: row.window.retainedStartMs,
          score_start_ms: row.window.startMs, score_end_ms: row.window.endMs, artifacts: selected.artifacts, contexts: row.window.contexts })
        nights.push({ ...row, input, excluded: selected.excluded })
      }
      catch (error) {
        refuse(row.night, error instanceof Error ? error.message : String(error))
      }
    }

    // Longest nights first keeps every worker busy until the end.
    nights.sort((a, b) => (b.input.score_end_ms - b.input.retained_start_ms) - (a.input.score_end_ms - a.input.retained_start_ms))
    const readingsDirectory = join(options.outputDirectory, 'readings')
    await mkdir(readingsDirectory, { recursive: true })
    const other: Side = options.side === 'left' ? 'right' : 'left'
    const results = new Map<string, NightResult>()
    const replayStarted = performance.now()
    let done = 0
    await runPool(nights, Array.from({ length: Math.min(jobs, Math.max(1, nights.length)) }, (_, index) => String(index)), async (night, _slot, signal) => {
      const itemStarted = performance.now()
      const directory = join(work, 'nights', night.night)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const paths = new Map(night.candidates.map(file => [file.sha256, file.path]))
      for (const source of night.input.artifacts) await linkOrCopy(paths.get(source.artifact.sha256) ?? '', join(directory, source.artifact.name))
      await writeFile(join(directory, '.lock'), '', { mode: 0o600 })
      const output = await runWaveformChild({ ...python, retainedDirectory: directory },
        { version: 'retained-waveform-work-v1', input: night.input, configs: { [options.side]: resolved as BiometricConfig, [other]: defaultConfig } },
        { signal, timeoutMs: 3600000, expectedBuildHash: build.hash })
      await writeFile(join(readingsDirectory, readingsFileName(night.night, configHash)),
        `${JSON.stringify({ cohortId: night.night, configHash, side: options.side, readings: output.readings })}\n`)
      await rm(directory, { recursive: true, force: true })
      const result: NightResult = { readings: output.readings.length, wallMs: performance.now() - itemStarted,
        run: { counts: output.run.counts, limitations: output.run.limitations } }
      if (options.compareStored) {
        const stored = storedVitals(db, options.side, night.input.score_start_ms, night.input.score_end_ms)
        const spans = warmRawSpans(night.input)
        const parity = storedParity(stored.vitals, output.readings.filter(row => row.side === options.side)
          .map(row => ({ timestampMs: row.timestampMs, heartRate: row.heartRate })), PARITY_TOLERANCE_BPM, spans)
        result.parity = { ...parity, comparedSpans: spans, gate: parityGate(parity.share, { storedConfigHashes: stored.configHashes, configHash,
          generations: nightGenerations(db, options.side, night.input.score_start_ms, night.input.score_end_ms).length }) }
      }
      results.set(night.night, result)
      progress(`[${++done}/${nights.length}] ${night.night} ${(result.wallMs / 1000).toFixed(1)}s`)
    })
    const replayWallMs = performance.now() - replayStarted

    const rows = [...nights].sort((a, b) => a.night.localeCompare(b.night)).map((night) => {
      const result = results.get(night.night)
      const inspectionOf = (sha256: string) => inspections.get(sha256) ?? null
      return { night: night.night, source: night.source, exportPath: night.exportPath, sessionIds: night.sessionIds,
        retainedStartMs: night.input.retained_start_ms, scoreStartMs: night.input.score_start_ms, scoreEndMs: night.input.score_end_ms,
        contexts: night.input.contexts.length,
        raw: night.input.artifacts.map(source => ({ sha256: source.artifact.sha256, name: night.candidates.find(file => file.sha256 === source.artifact.sha256)?.name ?? null,
          compressedBytes: source.artifact.compressed_bytes, expandedBytes: source.artifact.expanded_bytes, firstEventMs: source.first_event_ms, lastEventMs: source.last_event_ms })),
        rawExcluded: night.excluded.map(row => ({ ...row, name: night.candidates.find(file => file.sha256 === row.sha256)?.name ?? null,
          firstEventMs: inspectionOf(row.sha256)?.inventory.first_event_ms ?? null, lastEventMs: inspectionOf(row.sha256)?.inventory.last_event_ms ?? null })),
        generations: nightGenerations(db, options.side, night.input.score_start_ms, night.input.score_end_ms).map(row => ({ ...row, matchesReplayedConfig: row.resolvedHash === configHash })),
        storedConfigHashes: storedVitals(db, options.side, night.input.score_start_ms, night.input.score_end_ms).configHashes,
        readingsFile: `readings/${readingsFileName(night.night, configHash)}`, readings: result?.readings ?? 0, wallMs: result?.wallMs ?? null,
        run: result?.run ?? null, ...(result?.parity ? { parity: result.parity } : {}) }
    })
    const failed = rows.filter(row => row.parity?.gate === 'fail').map(row => row.night)
    const manifest = { version: 'biometrics-local-fit-replay-v1' as const, label: 'exploratory-local' as const, evidence: 'not_activation_evidence' as const,
      side: options.side, timezone: options.timezone, nightKey: 'local_noon_to_noon_night_of_entered_bed_at' as const,
      archive: { directory: options.archiveDirectory, podId: basename(options.archiveDirectory), databaseSha256: await sha256File(databasePath),
        cursorEndMs: await archiveCursor(options.archiveDirectory) },
      engine: { manifestHash }, config: { source: options.config.source, overrides: options.config.overrides, configHash },
      otherSideConfigHash: resolveConfig([]).hash,
      pythonBuild: { hash: build.hash, sourcesHash: build.sourcesHash, identity: build.identity },
      nights: rows, skipped,
      ...(options.compareStored
        ? { parity: { toleranceBpm: PARITY_TOLERANCE_BPM, minimumShare: PARITY_MINIMUM_SHARE,
            gatedNights: rows.filter(row => row.parity?.gate === 'pass' || row.parity?.gate === 'fail').length, failedNights: failed, passed: failed.length === 0 } }
        : {}),
      jobs, replayWallMs, totalWallMs: performance.now() - started }
    await writeFile(join(options.outputDirectory, 'replay.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  }
  finally {
    db.close()
    await rm(work, { recursive: true, force: true })
  }
}
