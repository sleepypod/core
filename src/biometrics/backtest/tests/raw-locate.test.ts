// @vitest-environment node
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { locateRawArchives } from '../raw-locate'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('finds archives written during a window with the cursor that reads each one', () => {
  dir = mkdtempSync(join(tmpdir(), 'raw-locate-'))
  const base = Date.UTC(2026, 9, 10, 6)
  const write = (name: string, minutes: number) => {
    writeFileSync(join(dir, name), '')
    utimesSync(join(dir, name), new Date(base + minutes * 60_000), new Date(base + minutes * 60_000))
  }
  write('0A.RAW.gz', 0)
  write('0B.RAW.gz', 15)
  write('0C.RAW.gz', 30)
  write('0D.RAW.gz', 45)
  write('notes.txt', 20)
  expect(locateRawArchives(base + 10 * 60_000, base + 32 * 60_000, dir)).toEqual([
    { name: '0B.RAW.gz', afterName: '0A.RAW.gz' },
    { name: '0C.RAW.gz', afterName: '0B.RAW.gz' },
    { name: '0D.RAW.gz', afterName: '0C.RAW.gz' },
  ])
  expect(locateRawArchives(base - 5 * 60_000, base, dir)[0]).toEqual({ name: '0A.RAW.gz', afterName: null })
  expect(locateRawArchives(0, 1, join(dir, 'missing'))).toEqual([])
})
