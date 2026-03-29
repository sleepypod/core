import { describe, it, expect } from 'vitest'

/**
 * Tests for iptables rule validation.
 * Since execSync can't run iptables in CI/dev, we test the rule
 * definitions and the check logic indirectly.
 */

describe('iptablesCheck module', () => {
  it('exports checkIptables and checkAndRepairIptables', async () => {
    const mod = await import('../iptablesCheck')
    expect(typeof mod.checkIptables).toBe('function')
    expect(typeof mod.checkAndRepairIptables).toBe('function')
  })

  it('checkIptables returns ok=true in dev (no iptables available)', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    // In dev/CI, iptables isn't available so all rules are assumed present
    expect(result.ok).toBe(true)
    expect(result.rules.length).toBeGreaterThan(0)
  })

  it('validates all critical rules are defined', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()

    // Verify expected rules exist in the check list
    const ruleNames = result.rules.map(r => r.name)
    expect(ruleNames).toContain('mDNS outbound (UDP 5353)')
    expect(ruleNames).toContain('mDNS inbound (UDP 5353)')
    expect(ruleNames).toContain('LAN access (192.168.0.0/16)')
    expect(ruleNames).toContain('NTP outbound (UDP 123)')
  })

  it('all rules are marked critical', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.rules.every(r => r.critical)).toBe(true)
  })

  it('rules cover both INPUT and OUTPUT chains', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    const chains = new Set(result.rules.map(r => r.chain))
    expect(chains.has('INPUT')).toBe(true)
    expect(chains.has('OUTPUT')).toBe(true)
  })
})
