/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { APP_BLOCK_WAN, chainOf, DROP_ONLY, FLUSHED, INSTALL_BLOCK_WAN, INTERNET_CONTROL_BLOCK, pick, type Ruleset } from './iptablesRulesets'

/**
 * Tests for iptables rule validation.
 * The module shells out via execSync; we mock node:child_process and
 * drive both branches (rules present, rules missing, repair, persist).
 */

vi.mock('node:child_process', () => {
  const execSync = vi.fn()
  const execFile = vi.fn()
  return { execSync, execFile, default: { execSync, execFile } }
})

import { execSync as mockedExecSync } from 'node:child_process'

const execSyncMock = mockedExecSync as unknown as ReturnType<typeof vi.fn>

interface ExecHandlerArgs {
  cmd: string
  options?: { encoding?: string, timeout?: number }
}

type ExecHandler = (args: ExecHandlerArgs) => string | Buffer | undefined

function setExecHandler(handler: ExecHandler): void {
  execSyncMock.mockImplementation((cmd: string, options?: any) => {
    const result = handler({ cmd, options })
    return result == null ? '' : result
  })
}

function unavailableError(message: string, status?: number): Error {
  const err = new Error(message) as Error & { status?: number }
  if (status !== undefined) err.status = status
  return err
}

/** Serve `iptables -S <chain>` from a ruleset; `which` resolves to /sbin/iptables. */
function serve(ruleset: Ruleset, extra?: (cmd: string) => string | undefined): void {
  setExecHandler(({ cmd }) => {
    if (cmd.includes('which iptables')) return '/sbin/iptables\n'
    const fromExtra = extra?.(cmd)
    if (fromExtra !== undefined) return fromExtra
    if (/ -S /.test(cmd)) {
      const listing = ruleset[chainOf(cmd) ?? '']
      if (listing === undefined) throw unavailableError('iptables: No chain/target/match by that name.', 1)
      return listing
    }
    return ''
  })
}

const withRules = (chain: string, ...rules: string[]) => `-P ${chain} DROP\n${rules.map(r => `-A ${chain} ${r}`).join('\n')}\n-A ${chain} -j DROP\n`

describe('iptablesCheck — module surface', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
    // Default: every call throws ENOENT-style — module assumes rules present.
    execSyncMock.mockImplementation(() => {
      throw unavailableError('iptables: command not found', 127)
    })
  })

  it('exports checkIptables and checkAndRepairIptables', async () => {
    const mod = await import('../iptablesCheck')
    expect(typeof mod.checkIptables).toBe('function')
    expect(typeof mod.checkAndRepairIptables).toBe('function')
  })

  it('checkIptables returns ok=true, state unknown, when iptables is unavailable', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
    expect(result.state).toBe('unknown')
    expect(result.rules.length).toBe(5)
  })

  it('validates all critical rules are defined', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()

    const ruleNames = result.rules.map(r => r.name)
    expect(ruleNames).toContain('mDNS outbound (UDP 5353)')
    expect(ruleNames).toContain('mDNS inbound (UDP 5353)')
    expect(ruleNames).toContain('mDNS outbound source (UDP 5353)')
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

describe('iptablesCheck — resolveIptablesPath', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
  })

  it('uses an explicit override path without invoking which', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) {
        throw new Error('which should not have been called')
      }
      return pick(INSTALL_BLOCK_WAN, chainOf(cmd))
    })
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables('/custom/path/iptables')
    expect(result.ok).toBe(true)
    // No `which` call should have happened in this run
    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(c => c.includes('which iptables'))).toBe(false)
    expect(calls.some(c => c.startsWith('/custom/path/iptables -S'))).toBe(true)
  })

  it('falls back to known POD_CAPS paths when which fails and a candidate is executable', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) throw unavailableError('which: not found', 127)
      if (cmd.startsWith('test -x ')) {
        // First candidate matches (/sbin/iptables)
        if (cmd.includes('/sbin/iptables')) return ''
        throw unavailableError('not found', 1)
      }
      return pick(INSTALL_BLOCK_WAN, chainOf(cmd))
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)

    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(c => c === 'which iptables 2>/dev/null')).toBe(true)
    expect(calls.some(c => c.startsWith('test -x /sbin/iptables'))).toBe(true)
    expect(calls.some(c => c.startsWith('/sbin/iptables -S'))).toBe(true)
    expect(execSyncMock).toHaveBeenCalledWith('test -x /sbin/iptables', { timeout: 2000 })
  })

  it('falls back to bare "iptables" when which fails and no candidate is executable', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) throw unavailableError('which: not found', 127)
      if (cmd.startsWith('test -x ')) throw unavailableError('not found', 1)
      return pick(DROP_ONLY, chainOf(cmd))
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()

    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls).toContain('iptables -S INPUT 2>/dev/null')
    expect(calls).toContain('iptables -S OUTPUT 2>/dev/null')
    // All rules missing → ok=false
    expect(result.ok).toBe(false)
    expect(result.rules.every(r => r.present === false)).toBe(true)
  })
})

describe('iptablesCheck — blocking rulesets', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
  })

  it.each([
    ['install block_wan', INSTALL_BLOCK_WAN],
    ['the app\'s blockWan', APP_BLOCK_WAN],
    ['internet-control block (allows inside SLEEPYPOD-BLOCK)', INTERNET_CONTROL_BLOCK],
  ])('reports %s as blocking with nothing missing', async (_name, ruleset) => {
    serve(ruleset)
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.state).toBe('blocking')
    expect(result.ok).toBe(true)
    expect(result.rules.filter(r => !r.present)).toEqual([])
  })

  it('lists SLEEPYPOD-BLOCK only when a chain jumps to it', async () => {
    serve(INSTALL_BLOCK_WAN)
    const { checkIptables } = await import('../iptablesCheck')
    checkIptables()
    expect(execSyncMock.mock.calls.map(c => String(c[0])).some(c => c.includes('SLEEPYPOD-BLOCK'))).toBe(false)
    execSyncMock.mockClear()
    serve(INTERNET_CONTROL_BLOCK)
    checkIptables()
    expect(execSyncMock).toHaveBeenCalledWith('/sbin/iptables -S SLEEPYPOD-BLOCK 2>/dev/null', { encoding: 'utf-8', timeout: 5000 })
  })

  it('reports a SLEEPYPOD-BLOCK missing the NTP allow as missing, not in place', async () => {
    const chain = INTERNET_CONTROL_BLOCK['SLEEPYPOD-BLOCK'].replace('-A SLEEPYPOD-BLOCK -p udp -m udp --dport 123 -j ACCEPT\n', '')
    serve({ ...INTERNET_CONTROL_BLOCK, 'SLEEPYPOD-BLOCK': chain })
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.state).toBe('missing')
    expect(result.rules.filter(r => !r.present).map(r => r.name)).toEqual(['NTP outbound (UDP 123)'])
  })

  it('reports unknown when OUTPUT jumps to SLEEPYPOD-BLOCK but that chain cannot be listed', async () => {
    serve({ INPUT: INTERNET_CONTROL_BLOCK.INPUT, OUTPUT: INTERNET_CONTROL_BLOCK.OUTPUT })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables()).toEqual(expect.objectContaining({ ok: false, state: 'unknown' }))
    warn.mockRestore()
  })

  it('reports a broad ACCEPT before the DROP as open', async () => {
    serve({ ...INSTALL_BLOCK_WAN, OUTPUT: INSTALL_BLOCK_WAN.OUTPUT.replace('-A OUTPUT -o lo -j ACCEPT\n', '-A OUTPUT -j ACCEPT\n') })
    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables()).toEqual(expect.objectContaining({ ok: true, state: 'open' }))
  })

  it('reports policy DROP with no DROP rule as blocking', async () => {
    serve({ ...INSTALL_BLOCK_WAN, OUTPUT: INSTALL_BLOCK_WAN.OUTPUT.replace('-A OUTPUT -j DROP\n', '') })
    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables().state).toBe('blocking')
  })

  it('reports policy ACCEPT with a DROP for one destination only as open', async () => {
    serve({ INPUT: FLUSHED.INPUT, OUTPUT: '-P OUTPUT ACCEPT\n-A OUTPUT -d 203.0.113.7/32 -j DROP\n' })
    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables()).toEqual(expect.objectContaining({ ok: true, state: 'open' }))
  })

  it('reports a broad ACCEPT inside SLEEPYPOD-BLOCK before its DROP as open', async () => {
    serve({ ...INTERNET_CONTROL_BLOCK, 'SLEEPYPOD-BLOCK': INTERNET_CONTROL_BLOCK['SLEEPYPOD-BLOCK'].replace('-A SLEEPYPOD-BLOCK -o lo -j ACCEPT', '-A SLEEPYPOD-BLOCK -j ACCEPT') })
    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables().state).toBe('open')
  })

  it('reports unknown for an unconditional jump to a chain it does not read', async () => {
    serve({ INPUT: FLUSHED.INPUT, OUTPUT: '-P OUTPUT ACCEPT\n-A OUTPUT -j STOCK-FILTER\n' })
    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables()).toEqual(expect.objectContaining({ ok: true, state: 'unknown' }))
  })

  it('reports an unparseable listing as unknown', async () => {
    serve({ INPUT: FLUSHED.INPUT, OUTPUT: 'Chain OUTPUT (policy ACCEPT)\ntarget     prot opt source               destination\n' })
    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables()).toEqual(expect.objectContaining({ ok: false, state: 'unknown' }))
  })
})

describe('iptablesCheck — parseChainSpec / chainVerdict', () => {
  it('ignores comments and logs, and lets conditional rules not decide', async () => {
    const { chainVerdict, parseChainSpec } = await import('../iptablesCheck')
    const verdict = (listing: string) => {
      const parsed = parseChainSpec(listing, 'OUTPUT')
      if (!parsed) throw new Error(`unparseable: ${listing}`)
      return chainVerdict(parsed)
    }
    expect(verdict('-P OUTPUT ACCEPT\n-A OUTPUT -m comment --comment "allow all" -j ACCEPT\n-A OUTPUT -j DROP\n')).toBe('open')
    expect(verdict('-P OUTPUT ACCEPT\n-A OUTPUT -j LOG --log-prefix "out "\n-A OUTPUT -j REJECT --reject-with icmp-port-unreachable\n')).toBe('blocking')
    expect(verdict('-P OUTPUT DROP\n-A OUTPUT -p tcp -j ACCEPT\n')).toBe('blocking')
    expect(verdict('-P OUTPUT ACCEPT\n-A OUTPUT -j RETURN\n-A OUTPUT -j DROP\n')).toBe('open')
  })

  it('rejects listings that are empty or for another chain', async () => {
    const { parseChainSpec } = await import('../iptablesCheck')
    expect(parseChainSpec('', 'OUTPUT')).toBeNull()
    expect(parseChainSpec('-P INPUT ACCEPT\n', 'OUTPUT')).toBeNull()
    expect(parseChainSpec('-P OUTPUT ACCEPT\n-A OUTPUT -j DROP\n', 'OUTPUT')).toEqual({
      policy: 'ACCEPT', rules: [{ target: 'DROP', conditional: false, args: ['-j', 'DROP'] }],
    })
  })
})

describe('iptablesCheck — checkIptables rule classification', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
  })

  it('marks each rule present when its allow is in the chain', async () => {
    serve(INSTALL_BLOCK_WAN)
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
    expect(result.state).toBe('blocking')
    expect(result.rules.find(r => r.name === 'LAN access (192.168.0.0/16)')?.present).toBe(true)
    expect(result.rules.find(r => r.name === 'NTP outbound (UDP 123)')?.present).toBe(true)
    expect(result.rules.find(r => r.name === 'mDNS outbound source (UDP 5353)')?.present).toBe(true)
  })

  it('marks rule absent when the blocking chain lacks its allow', async () => {
    serve({ ...INSTALL_BLOCK_WAN, INPUT: DROP_ONLY.INPUT })
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(false)
    expect(result.state).toBe('missing')
    expect(result.rules.find(r => r.name === 'LAN access (192.168.0.0/16)')?.present).toBe(false)
    expect(result.rules.find(r => r.name === 'mDNS inbound (UDP 5353)')?.present).toBe(false)
  })

  it('does not count a matching rule that is not an ACCEPT', async () => {
    serve({ ...INSTALL_BLOCK_WAN, OUTPUT: withRules('OUTPUT', '-p udp -m udp --dport 123 -j LOG', '-p udp -m udp --dport 5353 -j ACCEPT', '-p udp -m udp --sport 5353 -j ACCEPT') })
    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables().rules.find(r => r.name === 'NTP outbound (UDP 123)')?.present).toBe(false)
  })

  it('treats a chain that allows everything as satisfying its allow rules', async () => {
    // Internet access allowed: every rule flushed, policy ACCEPT, nothing dropped.
    serve(FLUSHED)
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
    // Reported as allowed, not as a firewall that is in place.
    expect(result.state).toBe('open')
  })

  it('still requires the allow rules in front of a drop', async () => {
    serve({ INPUT: withRules('INPUT'), OUTPUT: withRules('OUTPUT', '-p udp -m udp --dport 123 -j ACCEPT') })
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(false)
    expect(result.rules.find(r => r.name === 'NTP outbound (UDP 123)')?.present).toBe(true)
    expect(result.rules.find(r => r.name === 'mDNS outbound (UDP 5353)')?.present).toBe(false)
    expect(result.rules.find(r => r.name === 'LAN access (192.168.0.0/16)')?.present).toBe(false)
  })

  it('reports Permission denied / Operation not permitted from listing as unknown, not in place', async () => {
    serve({}, (cmd) => {
      if (cmd.startsWith('/sbin/iptables -S')) throw unavailableError('iptables v1.8.7: Permission denied (you must be root)')
      return undefined
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(false)
    expect(result.state).toBe('unknown')
    // Unverified, not missing: nothing to report or repair.
    expect(result.rules.every(r => r.present)).toBe(true)
  })

  it('reports unexpected listing failures as unknown and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    serve({}, (cmd) => {
      // status=2 is "other error" in iptables: not a recognised unavailable code
      if (cmd.startsWith('/sbin/iptables -S')) throw unavailableError('iptables: kernel module xt_udp not loaded', 2)
      return undefined
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result).toEqual(expect.objectContaining({ ok: false, state: 'unknown' }))
    const msgs = warnSpy.mock.calls.map(c => String(c[0]))
    expect(msgs).toContain('[iptables] Failed to check INPUT: iptables: kernel module xt_udp not loaded')
    warnSpy.mockRestore()
  })

  it('reports exit code 3 (Pod 4 without ip_tables loaded) as unknown even when the message says not found', async () => {
    serve({}, (cmd) => {
      if (cmd.startsWith('/sbin/iptables -S')) throw unavailableError('modprobe: FATAL: Module ip_tables not found', 3)
      return undefined
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(false)
    expect(result.state).toBe('unknown')
  })

  it.each([
    [unavailableError('binary not found')],
    [unavailableError('spawn ENOENT')],
    [unavailableError('No such file')],
    [unavailableError('exit 127', 127)],
  ])('assumes ok, but unknown, when the iptables binary is absent (dev/CI) %#', async (failure) => {
    setExecHandler(({ cmd, options }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -S')) {
        expect(options).toEqual({ encoding: 'utf-8', timeout: 5000 })
        throw failure
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables()).toEqual(expect.objectContaining({
      ok: true,
      state: 'unknown',
      repaired: [],
      rules: expect.arrayContaining([expect.objectContaining({ present: true })]),
    }))
  })

  it.each([
    [unavailableError('Permission denied')],
    [unavailableError('Operation not permitted')],
    [unavailableError('exit 3', 3)],
    [unavailableError('exit 4', 4)],
  ])('reports a pod iptables that cannot be listed as unknown, not ok %#', async (failure) => {
    serve({}, (cmd) => {
      if (cmd.startsWith('/sbin/iptables -S')) throw failure
      return undefined
    })

    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables()).toEqual(expect.objectContaining({ ok: false, state: 'unknown', repaired: [] }))
  })

  it('does not try to repair rules it could not list', async () => {
    serve({}, (cmd) => {
      if (cmd.startsWith('/sbin/iptables -S')) throw unavailableError('exit 3', 3)
      return undefined
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    expect(checkAndRepairIptables().repaired).toEqual([])
    expect(execSyncMock.mock.calls.some(c => String(c[0]).includes(' -I '))).toBe(false)
  })

  it.each([null, 'raw failure'])('handles non-Error listing failure %j without throwing', async (failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    serve({}, (cmd) => {
      if (cmd.startsWith('/sbin/iptables -S')) throw failure
      return undefined
    })

    const { checkIptables } = await import('../iptablesCheck')
    const status = checkIptables()

    expect(status).toEqual(expect.objectContaining({ ok: false, state: 'unknown' }))
    expect(warn).toHaveBeenCalledWith('[iptables] Failed to check INPUT: ')
    warn.mockRestore()
  })
})

describe('iptablesCheck — checkAndRepairIptables', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const missingLan = { ...INSTALL_BLOCK_WAN, INPUT: withRules('INPUT', '-p udp -m udp --dport 5353 -j ACCEPT') }

  it('returns repaired=[] when all rules are already present', async () => {
    serve(INSTALL_BLOCK_WAN)
    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.ok).toBe(true)
    expect(result.repaired).toEqual([])
  })

  it('repairs missing rules and persists via iptables-save', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const repaired: string[] = []
    let savedRules = false

    serve(missingLan, (cmd) => {
      if (cmd.includes('-I INPUT 1 -s 192.168.0.0/16')) {
        repaired.push(cmd)
        return ''
      }
      if (cmd.startsWith('/sbin/iptables-save')) {
        savedRules = true
        return ''
      }
      return undefined
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.repaired).toEqual(['LAN access (192.168.0.0/16)'])
    expect(repaired.length).toBe(1)
    expect(savedRules).toBe(true)
    const messages = logSpy.mock.calls.map(c => String(c[0]))
    expect(messages.some(m => m.includes('Repaired missing rule'))).toBe(true)
    expect(messages.some(m => m.includes('Saved 1 repaired rules'))).toBe(true)
    expect(execSyncMock).toHaveBeenCalledWith(
      '/sbin/iptables -I INPUT 1 -s 192.168.0.0/16 -j ACCEPT',
      { encoding: 'utf-8', timeout: 5000 },
    )
    expect(execSyncMock).toHaveBeenCalledWith(
      '/sbin/iptables-save > /etc/iptables/rules.v4',
      { encoding: 'utf-8', timeout: 5000 },
    )
    logSpy.mockRestore()
  })

  it('logs an error and continues when a repair invocation fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    serve(DROP_ONLY, (cmd) => {
      // Every repair fails
      if (cmd.includes('-I OUTPUT') || cmd.includes('-I INPUT')) throw unavailableError('iptables: not permitted', 4)
      return undefined
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.repaired).toEqual([])
    const errMsgs = errSpy.mock.calls.map(c => String(c[0]))
    expect(errMsgs.some(m => m.includes('Failed to repair rule'))).toBe(true)

    // No "Saved N repaired rules" log when nothing was repaired
    const logMsgs = logSpy.mock.calls.map(c => String(c[0]))
    expect(logMsgs.some(m => m.includes('Saved'))).toBe(false)

    logSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('warns when persisting via iptables-save fails after a successful repair', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    serve(missingLan, (cmd) => {
      if (cmd.includes('-I INPUT 1 -s 192.168.0.0/16')) return ''
      if (cmd.startsWith('/sbin/iptables-save')) throw unavailableError('No such file or directory: /etc/iptables/rules.v4')
      return undefined
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.repaired).toEqual(['LAN access (192.168.0.0/16)'])
    const warnMsgs = warnSpy.mock.calls.map(c => String(c[0]))
    expect(warnMsgs.some(m => m.includes('Failed to persist rules'))).toBe(true)

    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('derives iptables-save path from the resolved iptables path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let saveCmd = ''

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) throw unavailableError('not found', 1)
      if (cmd.startsWith('test -x ')) {
        if (cmd.includes('/usr/sbin/iptables')) return ''
        throw unavailableError('not found', 1)
      }
      if (cmd.startsWith('/usr/sbin/iptables -S')) return pick(DROP_ONLY, chainOf(cmd))
      // Repairs succeed
      if (cmd.includes('-I ')) return ''
      if (cmd.includes('iptables-save')) {
        saveCmd = cmd
        return ''
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.repaired.length).toBeGreaterThan(0)
    expect(saveCmd.startsWith('/usr/sbin/iptables-save > /etc/iptables/rules.v4')).toBe(true)
    logSpy.mockRestore()
  })

  it('replaces only the final iptables path component when deriving iptables-save', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const commands: string[] = []
    setExecHandler(({ cmd }) => {
      commands.push(cmd)
      if (cmd.includes(' -S ')) return pick(missingLan, chainOf(cmd))
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const status = checkAndRepairIptables('/opt/iptables-tools/iptables')

    expect(status.repaired).toEqual(['LAN access (192.168.0.0/16)'])
    expect(commands).toContain('/opt/iptables-tools/iptables-save > /etc/iptables/rules.v4')
    log.mockRestore()
  })

  it('repairs every missing allow at rule 1 so empty chains and terminal drops are safe', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const repairs: string[] = []
    serve(DROP_ONLY, (cmd) => {
      if (cmd.startsWith('/sbin/iptables -I')) {
        repairs.push(cmd)
        if (!/ -I (?:INPUT|OUTPUT) 1 /.test(cmd)) {
          throw unavailableError('iptables: Index of insertion too big', 1)
        }
        return ''
      }
      return undefined
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const status = checkAndRepairIptables()

    expect(status.repaired).toHaveLength(5)
    expect(repairs).toHaveLength(5)
    expect(repairs.every(cmd => / -I (?:INPUT|OUTPUT) 1 /.test(cmd))).toBe(true)
    log.mockRestore()
  })
})
