// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RemoteConflictError, RemoteStore } from '../store'
import { bindingSchema, configSchema, emptyConfig } from '../model'
describe('device remote persistence', () => {
  let sqlite: Database.Database
  let store: RemoteStore
  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec('CREATE TABLE remote_configuration (id INTEGER PRIMARY KEY, config TEXT NOT NULL)')
    store = new RemoteStore(sqlite)
  })
  afterEach(() => sqlite.close())
  it('persists overrides independently and rejects a stale writer without losing either side', () => {
    expect(store.read()).toEqual(emptyConfig())
    store.edit('left', 0, { kind: 'set', input: 'top.single', binding: { action: 'temp.up', deltaF: 2 } })
    expect(() => store.edit('right', 0, { kind: 'set', input: 'bottom.single', binding: { action: 'power.off' } })).toThrow(RemoteConflictError)
    store.edit('right', 1, { kind: 'set', input: 'bottom.single', binding: { action: 'power.off' } })
    const restored = new RemoteStore(sqlite).read()
    expect(restored.left).toEqual({ 'top.single': { action: 'temp.up', deltaF: 2 } })
    expect(restored.right).toEqual({ 'bottom.single': { action: 'power.off' } })
    expect(restored.revision).toBe(2)
  })
  it('adds a visible input without a binding, copies extras, and resets only the selected side', () => {
    store.edit('left', 0, { kind: 'add', input: 'top.double' })
    expect(store.read().left).toEqual({})
    store.edit('left', 1, { kind: 'set', input: 'top.double', binding: { action: 'none' } })
    store.edit('left', 2, { kind: 'copy' })
    store.edit('left', 3, { kind: 'resetSide' })
    expect(store.read()).toEqual({ revision: 4, left: {}, right: { 'top.double': { action: 'none' } }, extras: { left: [], right: ['top.double'] } })
    store.edit('right', 4, { kind: 'reset', input: 'top.double' })
    expect(store.read().extras.right).toEqual(['top.double'])
    store.edit('right', 5, { kind: 'remove', input: 'top.double' })
    expect(store.read().extras.right).toEqual([])
    expect(() => store.edit('right', 6, { kind: 'remove', input: 'mid.single' })).toThrow('cannot be removed')
    expect(store.read().revision).toBe(6)
  })
  it('fails closed on corrupted persistence and rejects unsupported hardware and display-string parameters', () => {
    sqlite.prepare('INSERT INTO remote_configuration VALUES (1, ?)').run('{broken')
    expect(() => store.read()).toThrow()
    expect(bindingSchema.safeParse({ action: 'elev.preset', param: 'Flat' }).success).toBe(false)
    expect(bindingSchema.safeParse({ action: 'temp.up', deltaF: '+1°F' }).success).toBe(false)
    expect(bindingSchema.safeParse({ action: 'temp.up', deltaF: 1, param: 'ignored' }).success).toBe(false)
    expect(configSchema.safeParse({ ...emptyConfig(), left: { 'top.triple': { action: 'none' } } }).success).toBe(false)
  })
})
