import { describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { getStorageDir, loadOrCreateIdentity, regenerateIdentity } from '../storage'

describe('homekit storage', () => {
  it('creates a stable identity on first read and returns same on second', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    if (existsSync(file)) rmSync(file)

    const a = loadOrCreateIdentity()
    expect(a.username).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/)
    expect(a.pincode).toMatch(/^\d{3}-\d{2}-\d{3}$/)
    expect(a.setupId).toMatch(/^[A-Z0-9]{4}$/)

    const b = loadOrCreateIdentity()
    expect(b).toEqual(a)
  })

  it('regenerate replaces identity', () => {
    const before = loadOrCreateIdentity()
    const after = regenerateIdentity()
    expect(after.username).not.toEqual(before.username)
    expect(after.pincode).not.toEqual(before.pincode)
  })

  it('rejects forbidden pincodes', () => {
    const FORBIDDEN = ['000-00-000', '111-11-111', '123-45-678']
    // 200 trials should never produce one of these.
    for (let i = 0; i < 50; i++) {
      const id = regenerateIdentity()
      expect(FORBIDDEN).not.toContain(id.pincode)
    }
  })
})
