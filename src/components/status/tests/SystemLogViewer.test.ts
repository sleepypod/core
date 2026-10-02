import { describe, expect, it } from 'vitest'
import { detectLevel, parseLogLine } from '../SystemLogViewer'

describe('detectLevel', () => {
  it('detects error-ish and warning-ish messages', () => {
    expect(detectLevel('ssh connect ERROR timeout')).toBe('ERROR')
    expect(detectLevel('Unhandled exception in loop')).toBe('ERROR')
    expect(detectLevel('fatal: nope')).toBe('ERROR')
    expect(detectLevel('WARN dropped 2 frames')).toBe('WARN')
    expect(detectLevel('warning: heatsink hot')).toBe('WARN')
    expect(detectLevel('debug tick')).toBe('DEBUG')
    expect(detectLevel('frame ok')).toBe('INFO')
  })

  it('does not match words that merely contain a level', () => {
    expect(detectLevel('errands scheduled')).toBe('INFO')
    expect(detectLevel('forewarned')).toBe('INFO')
  })

  it('falls back to the active priority floor', () => {
    expect(detectLevel('frame ok', 'error')).toBe('ERROR')
    expect(detectLevel('frame ok', 'warn')).toBe('WARN')
    expect(detectLevel('frame ok', 'info')).toBe('INFO')
  })
})

describe('parseLogLine', () => {
  it('splits a short-iso journalctl line into columns', () => {
    const raw = '2026-09-28T23:39:02+0000 pod sleepypod-piezo-processor[812]: WARN dropped 2 frames'
    expect(parseLogLine(raw)).toEqual({
      time: '23:39:02',
      level: 'WARN',
      service: 'piezo-processor',
      message: 'WARN dropped 2 frames',
      raw,
    })
  })

  it('keeps fractional seconds and names the core unit', () => {
    const p = parseLogLine('2026-09-28T23:39:02.114+0000 pod sleepypod[1]: applied set point')
    expect(p.time).toBe('23:39:02.114')
    expect(p.service).toBe('sleepypod')
    expect(p.level).toBe('INFO')
  })

  it('handles idents without a pid', () => {
    const p = parseLogLine('2026-09-28T01:02:03+0000 pod systemd: Started sleepypod.service')
    expect(p.service).toBe('systemd')
    expect(p.message).toBe('Started sleepypod.service')
  })

  it('passes unrecognized lines through as the message', () => {
    const p = parseLogLine('journalctl not available (dev environment)', 'warn')
    expect(p).toEqual({
      time: '',
      level: 'WARN',
      service: '',
      message: 'journalctl not available (dev environment)',
      raw: 'journalctl not available (dev environment)',
    })
  })
})
