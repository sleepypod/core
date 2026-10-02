import { describe, expect, it } from 'vitest'
import { buildLine, footerStatus, type SystemHealth } from '../footerStatus'

const ok: SystemHealth = { status: 'ok', database: { status: 'ok' }, scheduler: { drift: { drifted: false } }, iptables: { ok: true } }

describe('footerStatus', () => {
  it('is muted until the first health read', () => {
    expect(footerStatus(undefined, [])).toEqual({ tone: 'muted', summary: 'checking…', issues: [] })
  })
  it('is healthy with no failing checks or attention items', () => {
    expect(footerStatus(ok, [])).toEqual({ tone: 'ok', summary: 'healthy', issues: [] })
  })
  it('names failing checks before attention items', () => {
    const s = footerStatus(
      { status: 'degraded', database: { status: 'degraded' }, scheduler: { drift: { drifted: true } }, iptables: { ok: false } },
      [{ id: 'water', title: 'Water level is low', detail: '' }],
    )
    expect(s.tone).toBe('warn')
    expect(s.summary).toBe('4 issues')
    expect(s.issues).toEqual(['Database degraded', 'Scheduler drifted', 'Firewall rules missing', 'Water level is low'])
  })
  it('falls back to a generic line when degraded without a known cause', () => {
    expect(footerStatus({ ...ok, status: 'degraded' }, [])).toEqual({ tone: 'warn', summary: '1 issue', issues: ['System degraded'] })
  })
  it('counts attention items on an otherwise healthy pod', () => {
    const s = footerStatus(ok, [{ id: 'pump-stall', title: 'Pump-stall protection is off', detail: '' }])
    expect(s).toEqual({ tone: 'warn', summary: '1 issue', issues: ['Pump-stall protection is off'] })
  })
})

describe('buildLine', () => {
  it('shows branch and short commit on dev builds', () => {
    expect(buildLine({ branch: 'feat/ui-redesign', commitHash: 'ae930282a0f3', version: null })).toEqual({ branch: 'feat/ui-redesign', commit: 'ae93028' })
  })
  it('hides on tagged releases', () => {
    expect(buildLine({ branch: 'main', commitHash: 'ae930282a0f3', version: 'v1.2.3' })).toBeNull()
  })
  it('drops unknown parts', () => {
    expect(buildLine({ branch: 'unknown', commitHash: 'ae930282a0f3', version: null })).toEqual({ branch: null, commit: 'ae93028' })
    expect(buildLine({ branch: 'unknown', commitHash: 'unknown', version: null })).toBeNull()
    expect(buildLine(undefined)).toBeNull()
  })
})
