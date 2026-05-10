/**
 * Tests for the export archive route's pure helper. The streaming response
 * itself is exercised via the production smoke (a manual curl in the PR
 * description) — here we verify the file-selection logic that decides which
 * RAW waveforms and gzipped archives end up in the tarball.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { gatherRawFiles } from './route'

let root: string
let tmpfsDir: string
let archiveDir: string
let legacyDir: string

async function touchAt(file: string, unixSec: number) {
  await writeFile(file, '')
  await utimes(file, unixSec, unixSec)
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-export-test-'))
  tmpfsDir = path.join(root, 'biometrics')
  archiveDir = path.join(root, 'biometrics-archive')
  legacyDir = path.join(root, 'legacy')
  await mkdir(tmpfsDir)
  await mkdir(archiveDir)
  await mkdir(legacyDir)

  // tmpfs: live RAW frames at t=1000 and t=2000
  await touchAt(path.join(tmpfsDir, '00010001.RAW'), 1000)
  await touchAt(path.join(tmpfsDir, '00010002.RAW'), 2000)
  // archive: gzipped cold archives at t=500 and t=1500
  await touchAt(path.join(archiveDir, '00009998.RAW.gz'), 500)
  await touchAt(path.join(archiveDir, '00009999.RAW.gz'), 1500)
  // legacy /persistent: same basename as a tmpfs file (dedup target) plus a stray
  await touchAt(path.join(legacyDir, '00010001.RAW'), 1000)
  await touchAt(path.join(legacyDir, '00007777.RAW'), 800)
  // junk that must not match
  await touchAt(path.join(tmpfsDir, 'NOTRAW.txt'), 1500)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('gatherRawFiles', () => {
  it('returns files from all sources whose mtime falls in [startTs, endTs]', async () => {
    const result = await gatherRawFiles([tmpfsDir, archiveDir, legacyDir], 0, 5000)
    const names = result.map(f => f.basename).sort()
    expect(names).toEqual([
      '00007777.RAW',
      '00009998.RAW.gz',
      '00009999.RAW.gz',
      '00010001.RAW',
      '00010002.RAW',
    ])
  })

  it('includes both .RAW and .RAW.gz', async () => {
    const result = await gatherRawFiles([tmpfsDir, archiveDir], 0, 5000)
    const names = result.map(f => f.basename)
    expect(names).toContain('00010001.RAW')
    expect(names).toContain('00009999.RAW.gz')
  })

  it('filters by mtime window', async () => {
    const result = await gatherRawFiles([tmpfsDir, archiveDir], 1200, 1800)
    expect(result.map(f => f.basename)).toEqual(['00009999.RAW.gz'])
  })

  it('dedupes same basename across sources, preferring earlier dirs', async () => {
    const result = await gatherRawFiles([tmpfsDir, legacyDir], 0, 5000)
    const winners = result.filter(f => f.basename === '00010001.RAW')
    expect(winners).toHaveLength(1)
    expect(winners[0].abs.startsWith(tmpfsDir)).toBe(true)
  })

  it('rejects names that are not seqno.RAW or seqno.RAW.gz', async () => {
    const result = await gatherRawFiles([tmpfsDir], 0, 5000)
    expect(result.find(f => f.basename === 'NOTRAW.txt')).toBeUndefined()
  })

  it('tolerates missing source dirs', async () => {
    const result = await gatherRawFiles(
      ['/nonexistent/path/does/not/exist', tmpfsDir],
      0,
      5000,
    )
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns an empty list when no files match the window', async () => {
    const result = await gatherRawFiles([tmpfsDir, archiveDir], 9000, 9999)
    expect(result).toEqual([])
  })
})
