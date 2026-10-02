import type { AttentionItem } from '@/src/components/diagnostics/dashboardLogic'

export interface SystemHealth {
  status: 'ok' | 'degraded'
  database: { status: 'ok' | 'degraded' }
  scheduler: { drift?: { drifted: boolean } }
  iptables: { ok: boolean }
}

export interface FooterStatus {
  tone: 'ok' | 'warn' | 'muted'
  /** "healthy", "1 issue", "3 issues", or "checking…" before the first health read. */
  summary: string
  /** Everything that needs attention, most serious first. */
  issues: string[]
}

/**
 * Sidebar footer status: failing system checks first, then the same
 * attention items the System Dashboard lists.
 */
export function footerStatus(system: SystemHealth | undefined, attention: AttentionItem[]): FooterStatus {
  if (!system) return { tone: 'muted', summary: 'checking…', issues: [] }
  const issues: string[] = []
  if (system.database.status !== 'ok') issues.push('Database degraded')
  if (system.scheduler.drift?.drifted) issues.push('Scheduler drifted')
  if (!system.iptables.ok) issues.push('Firewall rules missing')
  if (system.status !== 'ok' && issues.length === 0) issues.push('System degraded')
  issues.push(...attention.map(a => a.title))
  if (issues.length === 0) return { tone: 'ok', summary: 'healthy', issues }
  return { tone: 'warn', summary: issues.length === 1 ? '1 issue' : `${issues.length} issues`, issues }
}

/** Dev builds only: branch + short commit. Tagged releases return null (the header chip covers them). */
export function buildLine(version: { branch: string, commitHash: string, version: string | null } | undefined): { branch: string | null, commit: string | null } | null {
  if (!version || version.version) return null
  const branch = version.branch !== 'unknown' ? version.branch : null
  const commit = version.commitHash !== 'unknown' ? version.commitHash.slice(0, 7) : null
  return branch || commit ? { branch, commit } : null
}
