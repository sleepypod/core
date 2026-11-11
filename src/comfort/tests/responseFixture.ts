import { randomUUID } from 'node:crypto'
import type { ThermalDatasetAudit, ThermalRecording } from '../thermal-dataset'
import type { ResponseApplication, ResponseSample } from '../response-window'

export function responseFixture(direction: -1 | 1 = 1) {
  const start = Date.UTC(2026, 10, 9, 22), at = start + 3 * 3_600_000, now = start + 24 * 3_600_000
  const target = 70 + direction
  const recording: ThermalRecording = { date: '2026-11-10', samples: Array.from({ length: 97 }, (_, index) => {
    const observed = start + index * 300_000
    return { at: observed, context: { targetF: observed < at ? 70 : target,
      waterF: 70 + direction * Math.min(0.5, Math.max(0, (observed - at) / 3_600_000)), roomF: 72, humidity: 50 } }
  }) }
  const application: ResponseApplication = { id: 1, attemptId: randomUUID(), attemptedAt: at, finishedAt: at + 100,
    side: 'left', reason: 'reconcile', source: 'schedule', targetF: target, durationSec: null, requestId: 'schedule:test',
    outcome: 'acknowledged', acknowledgment: 'accepted_not_physically_verified' }
  const samples: ResponseSample[] = Array.from({ length: 87 }, (_, index) => {
    const observed = at - 690_000 + index * 30_000
    return { at: observed, powered: true, targetF: observed < at ? 70 : target,
      waterF: 70 + direction * Math.min(0.5, Math.max(0, (observed - at) / 3_600_000)) }
  })
  const audit: ThermalDatasetAudit = { nights: [], recordings: [recording],
    proofs: [{ date: recording.date, reportId: 'a'.repeat(64), digest: 'b'.repeat(64), reviewId: 1, configuration: 'c'.repeat(64) }],
    collection: { feedbackNights: 1, excluded: [], policy: 'complete-reviewed-nights-v1' } }
  return { start, at, now, recording, application, samples, audit }
}
