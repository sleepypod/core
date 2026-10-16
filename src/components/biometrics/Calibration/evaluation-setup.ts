'use client'

import { useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import type { Split } from './calibration-model'

export type SetupStep = 'idle' | 'linking' | 'choosing' | 'freezing' | 'inspecting' | 'retaining' | 'protocol' | 'queueing' | 'done' | 'failed'
export interface SetupProgress { step: SetupStep, done?: number, total?: number, error?: string }

const PREROLL_MS = 5 * 60_000
const MIN_SESSION_S = 3600
const MAX_SESSION_MS = 15 * 3600_000
const DEFERRED_RETRY_MS = 5000
const DEFERRED_ATTEMPTS = 120
const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A replay protocol that recomputes the numbers these parameters change. */
export const WAVEFORM_PROTOCOL = { version: 'descriptive-evaluation-v1', mode: 'signal_replay', assumedStageCalibrationQuality: 0,
  pointToleranceMs: 30000, clockOffsetMs: 0 } as const

/** Local calendar day of the evening an instant belongs to; nights run noon to noon. */
export function nightKey(atMs: number, timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(atMs - 12 * 3600_000)
  }
  catch {
    return new Date(atMs - 12 * 3600_000).toISOString().slice(0, 10)
  }
}

/** Every noon-to-noon night a session touches. The server joins sessions that share one into a single cohort. */
export function nightsTouched(startMs: number, endMs: number, timezone: string) {
  const keys = new Set<string>()
  for (let at = startMs; at < endMs; at += 3600_000) keys.add(nightKey(at, timezone))
  keys.add(nightKey(Math.max(startMs, endMs - 1), timezone))
  return keys
}

/**
 * The newest `nights` covered sessions, oldest first, one per night: a session
 * that shares a night with one already chosen is skipped, so every frozen
 * cohort is a single session. Sessions longer than a replay can retain are
 * skipped too (64 archives of 15 minutes, with five minutes of pre-roll).
 */
export function chooseSessions<S extends { id: number, startMs: number, endMs: number, sleepDurationSeconds: number }>(
  sessions: S[], covered: Array<{ startMs: number, endMs: number }>, nights: number, timezone: string) {
  const usable = sessions.filter(s => s.sleepDurationSeconds >= MIN_SESSION_S && s.endMs - s.startMs <= MAX_SESSION_MS
    && covered.some(c => c.startMs < s.endMs && c.endMs > s.startMs))
    // Newest night first; within a night, the main sleep before any nap.
    .sort((a, b) => nightKey(b.startMs, timezone).localeCompare(nightKey(a.startMs, timezone)) || (b.endMs - b.startMs) - (a.endMs - a.startMs))
  const taken = new Set<string>()
  const chosen: S[] = []
  for (const session of usable) {
    if (chosen.length === nights) break
    const touched = nightsTouched(session.startMs, session.endMs, timezone)
    if ([...touched].some(key => taken.has(key))) continue
    touched.forEach(key => taken.add(key))
    chosen.push(session)
  }
  return chosen.sort((a, b) => a.startMs - b.startMs)
}

/**
 * One click from "a reference is imported" to "the saved profile has been
 * replayed": link older Watch rows, freeze the newest referenced nights,
 * inspect and retain their RAW archives, set up a waveform replay and queue
 * it on every split. Each step is idempotent under one key, so a retry after
 * a failure resumes instead of duplicating work.
 */
export function useEvaluationSetup({ side, timezone, savedRevisionId, generation, nights = 7 }: {
  side: 'left' | 'right'
  timezone: string
  savedRevisionId: string | null
  generation: number
  nights?: number
}) {
  const utils = trpc.useUtils()
  const [progress, setProgress] = useState<SetupProgress>({ step: 'idle' })
  const key = useRef(randomKey())

  async function deferred<T extends { status: string }>(attempt: () => Promise<T>): Promise<Exclude<T, { status: 'deferred' }>> {
    for (let i = 0; i < DEFERRED_ATTEMPTS; i++) {
      const result = await attempt()
      if (result.status !== 'deferred') return result as Exclude<T, { status: 'deferred' }>
      await sleep(DEFERRED_RETRY_MS)
    }
    throw new Error('The pod kept deferring archive work; try again when it is less busy.')
  }

  async function run() {
    const api = utils.client.biometricTuning
    try {
      setProgress({ step: 'linking' })
      const legacy = await api.countLegacyReferences.query({ side })
      if (legacy.vitals + legacy.stages > 0) await api.linkLegacyReferences.mutate({ side })

      setProgress({ step: 'choosing' })
      const imports = []
      let importCursor: { createdAtMs: number, id: string } | null = null
      for (let page = 0; page < 10; page++) {
        const result = await api.listImports.query({ side, ...(importCursor ? { beforeCreatedAtMs: importCursor.createdAtMs, beforeId: importCursor.id } : {}) })
        imports.push(...result.items)
        importCursor = result.nextCursor
        if (!importCursor) break
      }
      const available = imports.filter(i => i.available && i.summary.startMs !== null && i.summary.endMs !== null)
      if (!available.length) throw new Error('Import a reference for this side first.')
      const subjectId = available[0].summary.subjectId
      const references = available.filter(i => i.summary.subjectId === subjectId)
      const covered = references.map(i => ({ startMs: i.summary.startMs as number, endMs: i.summary.endMs as number }))
      const earliest = Math.min(...covered.map(c => c.startMs))

      const sessions = []
      let sessionCursor: { startMs: number, id: number } | null = null
      for (let page = 0; page < 20; page++) {
        const result = await api.listSessions.query({ side, ...(sessionCursor ? { beforeStartMs: sessionCursor.startMs, beforeId: sessionCursor.id } : {}) })
        sessions.push(...result.items)
        sessionCursor = result.nextCursor
        if (!sessionCursor || result.items.every(s => s.endMs < earliest)) break
      }
      // Only nights whose RAW archives still exist can be replayed.
      const withArchives = []
      for (const session of chooseSessions(sessions, covered, nights * 2, timezone).reverse()) {
        if ((await api.locateRawArchives.query({ startMs: session.startMs, endMs: session.endMs })).length) withArchives.push(session)
      }
      const chosen = chooseSessions(withArchives, covered, nights, timezone)
      if (!chosen.length) throw new Error('No recorded night with retained RAW archives overlaps the reference.')
      const span = { startMs: chosen[0].startMs, endMs: chosen[chosen.length - 1].endMs }
      const referenceImportIds = references.filter(i => (i.summary.startMs as number) < span.endMs && (i.summary.endMs as number) > span.startMs)
        .slice(0, 20).map(i => i.id)

      setProgress({ step: 'freezing' })
      const dataset = await api.createDataset.mutate({ side, subjectId, sessionIds: chosen.map(s => s.id), referenceImportIds, idempotencyKey: `${key.current}:dataset` })
      const cohorts = dataset.manifest.splitProtocol.assignments

      const located = new Map<string, string | null>()
      for (const cohort of cohorts) {
        for (const archive of await api.locateRawArchives.query({ startMs: cohort.startMs - PREROLL_MS, endMs: cohort.endMs })) located.set(archive.name, archive.afterName)
      }
      const inspected = new Map<string, { id: string, first: number | null, last: number | null, ordered: boolean }>()
      const remember = (source: { id: string, inspection: { source_name: string, inventory: { first_event_ms: number | null, last_event_ms: number | null, ordered_waveform_available: boolean } } }) =>
        inspected.set(source.inspection.source_name, { id: source.id, first: source.inspection.inventory.first_event_ms,
          last: source.inspection.inventory.last_event_ms, ordered: source.inspection.inventory.ordered_waveform_available })
      for (const cohort of cohorts) {
        let afterId: string | undefined
        for (let page = 0; page < 20; page++) {
          const result = await api.listRawSources.query({ startMs: cohort.startMs - PREROLL_MS, endMs: cohort.endMs, ...(afterId ? { afterId } : {}) })
          result.items.filter(s => s.unavailableAtMs === null).forEach(remember)
          if (!result.nextCursor) break
          afterId = result.nextCursor
        }
      }
      const pending = [...located].filter(([name]) => !inspected.has(name))
      let done = 0
      setProgress({ step: 'inspecting', done, total: pending.length })
      for (const [, afterName] of pending) {
        const result = await deferred(() => api.inspectRawSource.mutate({ afterName }))
        if (result.status === 'inspected') remember(result.source)
        setProgress({ step: 'inspecting', done: ++done, total: pending.length })
      }

      setProgress({ step: 'retaining' })
      const selection = cohorts.map((cohort) => {
        const ids = [...new Set([...inspected.values()].filter(s => s.ordered && s.first !== null && s.last !== null
          && s.first <= cohort.endMs && s.last >= cohort.startMs - PREROLL_MS).map(s => s.id))].slice(0, 64)
        return { cohortId: cohort.cohortId, sourceIds: ids }
      })
      if (selection.some(c => !c.sourceIds.length)) throw new Error('A frozen night has no readable RAW archive; freeze again once its archives are inspected.')
      const retained = await deferred(() => api.createWaveformDataset.mutate({ parentDatasetId: dataset.id, expectedContentHash: dataset.contentHash,
        cohorts: selection, idempotencyKey: `${key.current}:waveform` }))

      setProgress({ step: 'protocol' })
      const experiment = await api.createExperiment.mutate({ datasetId: retained.dataset.id, protocol: WAVEFORM_PROTOCOL, idempotencyKey: `${key.current}:experiment` })

      setProgress({ step: 'queueing' })
      // On system defaults there is no saved revision; replay an unrequested one that resolves to the defaults.
      const candidate = savedRevisionId ?? (await api.createProfileRevision.mutate({ side, overrides: [], origin: 'manual',
        requester: 'web-calibration', idempotencyKey: `${key.current}:defaults` })).id
      const splits = new Set(retained.dataset.manifest.splitProtocol.assignments.map(a => a.split))
      for (const split of (['tuning', 'validation', 'holdout'] as Split[]).filter(s => splits.has(s))) {
        await api.enqueueBacktest.mutate({ experimentId: experiment.id, candidateRevisionId: candidate, expectedBindingGeneration: generation,
          split, idempotencyKey: `${key.current}:${split}` })
      }
      setProgress({ step: 'done' })
    }
    catch (cause) {
      setProgress({ step: 'failed', error: cause instanceof Error ? cause.message : String(cause) })
    }
    finally {
      void utils.biometricTuning.invalidate()
    }
  }

  const running = !['idle', 'done', 'failed'].includes(progress.step)
  const start = () => {
    if (!running) void run()
  }
  return { progress, running, run: start }
}
