import { describe, expect, it } from 'vitest'
import { isRemoteEvidence, RemoteRecording } from '../capture'

describe('remote firmware evidence', () => {
  it('retains unknown counts and controller codes without including sensor samples', () => {
    expect(isRemoteEvidence({ type: 'buttonEvent', left: { newButton: 7 } })).toBe(true)
    expect(isRemoteEvidence({ type: 'log', msg: '[tca8418R] gpi press 105' })).toBe(true)
    expect(isRemoteEvidence({ type: 'log', msg: '[i2c3] failed tx' })).toBe(true)
    expect(isRemoteEvidence({ type: 'remoteReset' })).toBe(true)
    expect(isRemoteEvidence({ type: 'piezo-dual', left1: [1, 2] })).toBe(false)
    expect(isRemoteEvidence({ type: 'log', msg: 'unrelated log' })).toBe(false)
  })
  it('bounds records, preserves evidence order, and reports dropped data in its export', () => {
    const capture = new RemoteRecording(2)
    capture.append({ type: 'raw', record: { type: 'buttonEvent', left: { top: 9 } } })
    capture.append({ type: 'connection_gap' })
    capture.append({ type: 'raw', record: 'later' })
    const rows = capture.export({ notes: 'left top ×9' }).trim().split('\n').map(line => JSON.parse(line))
    expect(rows[0]).toMatchObject({ schemaVersion: 1, notes: 'left top ×9' })
    expect(rows[1].record.left.top).toBe(9)
    expect(rows[2].type).toBe('connection_gap')
    expect(rows[3]).toEqual({ type: 'capture_summary', retained: 2, omitted: 1 })
  })
  it('enforces the UTF-8 byte budget, including newline bytes', () => {
    const capture = new RemoteRecording(100, 10)
    capture.append('éééé')
    expect(capture.count).toBe(0)
    expect(capture.dropped).toBe(1)
    capture.append('ok')
    expect(capture.count).toBe(1)
  })
})
