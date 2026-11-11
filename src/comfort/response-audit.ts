import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { Side } from '@/src/hardware/types'
import { temperatureApplicationSchema } from '@/src/temperature/applications'
import { thermalDatasetAudit, type ThermalDatasetAudit } from './thermal-dataset'
import { RESPONSE_POLICY, responseAuditSchema, type ResponseAudit } from './response-contract'
import { assessResponseWindow, RESPONSE_BEFORE_MS, RESPONSE_AFTER_MS, responseSampleSchema, responseWindowSchema, type ResponseWindow } from './response-window'

interface ApplicationRow { id: number, attemptId: string, attemptedAt: number, finishedAt: number | null, outcome: string, requestBytes: number }
export interface ResponseEvidence {
  audit: ResponseAudit
  configuration: string | null
  windows: Array<{ window: ResponseWindow, sourceHash: string }>
}

export function responseEvidenceHash(side: Side, configuration: string | null, windows: ResponseEvidence['windows']): string {
  const ordered = windows.map(item => ({ window: responseWindowSchema.parse(item.window), sourceHash: item.sourceHash }))
    .sort((first, second) => first.window.at - second.window.at || first.window.attemptId.localeCompare(second.window.attemptId))
  return createHash('sha256').update(JSON.stringify([RESPONSE_POLICY, side, configuration, ordered])).digest('hex')
}

export function readResponseAudit(database: Database.Database, biometrics: Database.Database, side: Side, now: number,
  audit: (database: Database.Database, side: Side, now: number) => ThermalDatasetAudit = thermalDatasetAudit): ResponseAudit {
  return readResponseEvidence(database, biometrics, side, now, audit).audit
}

/** Join reviewed nights to command receipts and actual water samples; no device or model is started. */
export function readResponseEvidence(database: Database.Database, biometrics: Database.Database, side: Side, now: number,
  audit: (database: Database.Database, side: Side, now: number) => ThermalDatasetAudit = thermalDatasetAudit): ResponseEvidence {
  z.enum(['left', 'right']).parse(side)
  z.number().int().positive().max(8_640_000_000_000_000).parse(now)
  const result: ResponseAudit = { apiVersion: 1, policy: RESPONSE_POLICY, generatedAt: now, side, attribution: 'physical_zone_only',
    status: 'read', reviewedNights: 0, responseNights: 0, coolingWindows: 0, warmingWindows: 0, requiredNights: 20,
    datasetHash: '0'.repeat(64), modelAvailable: false, activationAvailable: false, exclusions: [], exclusionsTruncated: false,
    reason: 'Collecting actual small target changes. No target-response model is fitted and no adjustment is enabled.' }
  const excluded = new Map<string, ResponseAudit['exclusions'][number]>()
  const exclude = (date: string, reason: string) => {
    const key = JSON.stringify([date, reason]), previous = excluded.get(key)
    excluded.set(key, { date, reason, count: (previous?.count ?? 0) + 1 })
  }
  try {
    return database.transaction(() => biometrics.transaction(() => {
      const source = audit(database, side, now)
      if (source.recordings.length > 90) throw new Error('Reviewed-night inspection limit exceeded')
      const current = [...source.proofs].sort((first, second) => second.date.localeCompare(first.date))[0]?.configuration
      const windows: Array<{ window: ResponseWindow, sourceHash: string }> = []
      let bytes = 0, thermalRows = 0
      for (const item of source.collection.excluded) exclude(item.date, item.reason)
      for (const night of source.recordings) {
        const proof = source.proofs.find(item => item.date === night.date)
        if (!proof || proof.configuration !== current) {
          exclude(night.date, 'This night does not match the latest reviewed hardware, schedule and room configuration.')
          continue
        }
        result.reviewedNights++
        const first = night.samples[0]?.at, last = night.samples.at(-1)?.at
        if (!first || !last || first < now - 30 * 86_400_000) {
          exclude(night.date, 'The night is outside the retained 30-day command-evidence window.')
          continue
        }
        const rows = database.prepare(`SELECT id,attempt_id AS attemptId,attempted_at AS attemptedAt,finished_at AS finishedAt,outcome,
          length(CAST(request AS BLOB)) AS requestBytes
          FROM temperature_applications WHERE side=? AND attempted_at>=? AND attempted_at<=? ORDER BY attempted_at,id LIMIT 1001`)
          .all(side, first - RESPONSE_BEFORE_MS, last + RESPONSE_AFTER_MS) as ApplicationRow[]
        let invalid = rows.length > 1000
        const applications = rows.slice(0, 1000).flatMap((row) => {
          try {
            if (!Number.isSafeInteger(row.requestBytes) || row.requestBytes <= 0 || row.requestBytes > 65536
              || bytes + row.requestBytes > 4 * 1024 ** 2) throw new Error('Read budget exceeded')
            bytes += row.requestBytes
            const payload = database.prepare('SELECT request FROM temperature_applications WHERE id=? AND side=?')
              .get(row.id, side) as { request: string }
            const value = temperatureApplicationSchema.parse({ ...JSON.parse(payload.request), id: row.id, attemptId: row.attemptId,
              attemptedAt: row.attemptedAt, finishedAt: row.finishedAt, outcome: row.outcome,
              acknowledgment: row.outcome === 'acknowledged' ? 'accepted_not_physically_verified' : 'unconfirmed' })
            if (value.side !== side || value.attemptedAt > now || (value.finishedAt !== null && value.finishedAt > now)) throw new Error('Invalid receipt identity or time')
            return [value]
          }
          catch {
            invalid = true
            return []
          }
        })
        if (invalid) {
          result.status = 'partial'
          exclude(night.date, 'Command evidence is incomplete, malformed or exceeds the bounded read; this night was excluded.')
          continue
        }
        const changes = applications.filter(item => item.reason !== 'keepalive')
        if (!changes.length) exclude(night.date, 'No retained target-change command is available for this reviewed night.')
        if (changes.length > 64) {
          result.status = 'partial'
          exclude(night.date, 'Too many target changes to audit this night within the inspection limit.')
          continue
        }
        const nightSourceHash = createHash('sha256').update(JSON.stringify([proof, night, applications])).digest('hex')
        for (const application of changes) {
          if (thermalRows + 301 > 50_000) {
            result.status = 'partial'
            exclude(night.date, 'The water inspection budget is exhausted; remaining changes were not audited.')
            continue
          }
          const start = application.attemptedAt - RESPONSE_BEFORE_MS - 90_000
          const end = application.attemptedAt + RESPONSE_AFTER_MS + 90_000
          const raw = biometrics.prepare(`SELECT timestamp*1000 AS at,is_powered AS powered,target_temp_f AS targetF,current_temp_f AS waterF
            FROM thermal_state WHERE side=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp,id LIMIT 301`)
            .all(side, start / 1000, end / 1000) as Array<{ at: number, powered: unknown, targetF: unknown, waterF: unknown }>
          thermalRows += raw.length
          const parsed = z.array(responseSampleSchema).max(300).safeParse(raw.map(sample => ({ ...sample,
            powered: sample.powered === 1 ? true : sample.powered === 0 ? false : sample.powered })))
          if (!parsed.success) {
            result.status = 'partial'
            exclude(night.date, 'Water evidence is malformed or exceeds the bounded inspection limit.')
            continue
          }
          const checked = assessResponseWindow(night, application, applications, parsed.data, now)
          if (!checked.window) {
            exclude(night.date, checked.reason)
            continue
          }
          const sourceHash = createHash('sha256').update(JSON.stringify([nightSourceHash, parsed.data])).digest('hex')
          windows.push({ window: checked.window, sourceHash })
        }
      }
      result.responseNights = new Set(windows.map(item => item.window.date)).size
      result.coolingWindows = windows.filter(item => item.window.requestedTargetF < item.window.previousTargetF).length
      result.warmingWindows = windows.length - result.coolingWindows
      result.datasetHash = responseEvidenceHash(side, current ?? null, windows)
      result.exclusions = [...excluded.values()].slice(0, 300)
      result.exclusionsTruncated = excluded.size > 300
      result.reason = `${result.responseNights} reviewed nights contain qualifying 1°F target changes. A minimum of 20 distinct nights is a collection milestone, not proof of model quality. Observed responses are not randomized causal effects, body temperature or comfort outcomes. No model is fitted or activated by this audit.`
      return { audit: responseAuditSchema.parse(result), configuration: current ?? null, windows }
    })())()
  }
  catch {
    return { audit: responseAuditSchema.parse({ ...result, status: 'unavailable', reviewedNights: 0, responseNights: 0,
      coolingWindows: 0, warmingWindows: 0, datasetHash: '0'.repeat(64), exclusions: [], exclusionsTruncated: false,
      reason: 'Reviewed-night, command or water evidence could not be read. No response readiness can be established.' }), configuration: null, windows: [] }
  }
}
