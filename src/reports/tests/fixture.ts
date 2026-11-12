import { randomUUID } from 'node:crypto'
import type { SavedMorningReport } from '../morning'
import type { ReportScope } from '../store'

export const reportNow = Date.parse('2026-11-11T12:00:00Z')
export const legacyReportScope = (): ReportScope => ({ kind: 'legacy', installationId: randomUUID() })
export const personalReportScope = (): ReportScope => ({ kind: 'personal', podId: randomUUID(), householdId: randomUUID(), accountId: randomUUID(), sleeperId: randomUUID() })
export function reportFixture(id = randomUUID()) {
  const report: SavedMorningReport = { id, createdAt: reportNow - 60_000, provider: 'apple', model: 'fixture-local-model',
    source: 'Synthetic Health fixture', facts: [{ id: 'health.coverage', text: 'Three recorded days; completeness unknown.' }],
    text: '### Coverage\nThese fixture records do not establish a sleep improvement. [health.coverage]', followUps: [] }
  return { version: 1 as const, report }
}
export function appendAnswer(document: ReturnType<typeof reportFixture>, text = 'This is a descriptive fixture, not a causal result.') {
  return { ...document, report: { ...document.report, followUps: [...document.report.followUps ?? [], {
    id: randomUUID(), createdAt: reportNow, provider: 'apple' as const, model: 'fixture-local-model', question: 'What does the coverage mean?', text,
  }] } }
}
