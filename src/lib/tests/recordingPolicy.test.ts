// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeRecordingPolicy, DEFAULT_RECORDING_POLICY, effectiveLoggingMode } from '../recordingPolicy'
import { getRecordingPolicy, setRecordingPolicy } from '../recordingStore'
import { shouldLog } from '../appLogging'

let root: string
let file: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recording-policy-'))
  file = join(root, 'recording-policy.json')
  vi.stubEnv('SP_RECORDING_POLICY_FILE', file)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('recording policy', () => {
  it('defaults to quiet and preserves history without writing merely to read', () => {
    expect(getRecordingPolicy()).toEqual(DEFAULT_RECORDING_POLICY)
    expect(existsSync(file)).toBe(false)
  })

  it('persists independent switches and restores them after cache expiry', () => {
    setRecordingPolicy({ rawArchive: false }, 1000)
    setRecordingPolicy({ healthHistory: false, loggingMode: 'off' }, 2000)
    expect(getRecordingPolicy(4000)).toEqual({ loggingMode: 'off', healthHistory: false, rawArchive: false, debugUntil: null })
    expect(JSON.parse(readFileSync(file, 'utf8')).rawArchive).toBe(false)
  })

  it('expires debug without a timer or another disk write, returning to the prior mode', () => {
    const off = changeRecordingPolicy(DEFAULT_RECORDING_POLICY, { loggingMode: 'off' }, 0)
    const debug = changeRecordingPolicy(off, { debug: true }, 100)
    expect(effectiveLoggingMode(debug, 100)).toBe('debug')
    expect(effectiveLoggingMode(debug, 900099)).toBe('debug')
    expect(effectiveLoggingMode(debug, 900100)).toBe('off')
    expect(changeRecordingPolicy(debug, { debug: false }).loggingMode).toBe('off')
    expect(changeRecordingPolicy(debug, { loggingMode: 'quiet' }).debugUntil).toBeNull()
    expect(changeRecordingPolicy(debug, { rawArchive: false }).debugUntil).toBe(debug.debugUntil)
  })

  it('does not silently reset unreadable preferences or overwrite a malformed policy', () => {
    writeFileSync(file, '{broken')
    expect(() => getRecordingPolicy(0, true)).toThrow()
    expect(() => setRecordingPolicy({ rawArchive: true })).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })

  it('filters severity explicitly: off drops errors too; debug permits all levels', () => {
    expect(shouldLog('warn', 'quiet')).toBe(true)
    expect(shouldLog('error', 'quiet')).toBe(true)
    expect(shouldLog('info', 'quiet')).toBe(false)
    expect(shouldLog('log', 'quiet')).toBe(false)
    expect(shouldLog('error', 'off')).toBe(false)
    expect(shouldLog('debug', 'debug')).toBe(true)
  })
})
