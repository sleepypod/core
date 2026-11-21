// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
  const { fileURLToPath } = await import('node:url')
  const schema = await import('@/src/db/schema')
  const db = drizzle(new BetterSqlite3(':memory:'), { schema })
  migrate(db, { migrationsFolder: fileURLToPath(new URL('../../db/migrations/', import.meta.url)) })
  return { db }
})

import { db } from '@/src/db'
import { deviceSettings, sideSettings } from '@/src/db/schema'
import { readAwayModes } from '../awayModes'

describe('readAwayModes', () => {
  it('reads each side\'s away mode and the bed mode', async () => {
    await db.insert(deviceSettings).values({ id: 1, bedMode: 'solo-left', unusedZoneMode: 'off' }).onConflictDoUpdate({
      target: deviceSettings.id,
      set: { bedMode: 'solo-left', unusedZoneMode: 'off' },
    })
    await db.delete(sideSettings)
    await db.insert(sideSettings).values([
      { side: 'left', name: 'Left', awayMode: false },
      { side: 'right', name: 'Right', awayMode: true },
    ])
    expect(await readAwayModes()).toEqual({
      left: { awayMode: false },
      right: { awayMode: true },
      bedMode: 'solo-left',
      unusedZoneMode: 'off',
    })
  })
})
