// @vitest-environment node
import { mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnalysisExportTooLargeError, analysisExportDownloadPath, analysisWindowSchema, listWindowArchives, planAnalysisExport, tarBytes } from '../analysis-export'

const START = Date.UTC(2026, 9, 10, 6)
const END = Date.UTC(2026, 9, 10, 14)
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'analysis-window-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('analysisWindowSchema', () => {
  it('accepts ISO 8601 and epoch ms and defaults includeRaw', () => {
    expect(analysisWindowSchema.parse({ start: '2026-10-10T06:00:00Z', end: String(END) })).toEqual({ startMs: START, endMs: END, includeRaw: true })
    expect(analysisWindowSchema.parse({ start: String(START), end: '2026-10-10T07:00:00-07:00', includeRaw: false })).toEqual({ startMs: START, endMs: END, includeRaw: false })
  })

  it.each([
    [{ start: 'soon', end: String(END) }, /start must be an ISO 8601/],
    [{ start: String(END), end: String(START) }, /start must be before end/],
    [{ start: String(START), end: String(START + 14 * 86_400_000 + 1) }, /14 days or shorter/],
    [{ start: String(START), end: String(END), extra: 1 }, /Unrecognized key/],
  ])('rejects %j', (input, message) => {
    const result = analysisWindowSchema.safeParse(input)
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(issue => issue.message).join('; ')).toMatch(message)
  })
})

describe('planAnalysisExport', () => {
  const at = (name: string, mtimeMs: number, bytes = 10) => {
    const path = join(directory, name)
    writeFileSync(path, Buffer.alloc(bytes))
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  }

  it('includes the inclusive [start − 20 min, end + 45 min] mtime range, oldest first', async () => {
    at('B.RAW.gz', END + 45 * 60_000)
    at('A.RAW.gz', START - 20 * 60_000)
    at('C.RAW.gz', START - 20 * 60_000 - 1000)
    at('D.RAW.gz', END + 45 * 60_000 + 1000)
    expect((await listWindowArchives({ startMs: START, endMs: END }, directory)).map(archive => archive.name)).toEqual(['A.RAW.gz', 'B.RAW.gz'])
  })

  it('treats a missing archive directory as empty and skips listing when RAW is off', async () => {
    expect(await listWindowArchives({ startMs: START, endMs: END }, join(directory, 'missing'))).toEqual([])
    at('A.RAW.gz', START)
    expect(await planAnalysisExport({ startMs: START, endMs: END, includeRaw: false }, directory)).toMatchObject({ archives: [], rawBytes: 0 })
  })

  it('sums RAW bytes and rejects past the cap', async () => {
    at('A.RAW.gz', START, 100)
    at('B.RAW.gz', START + 1000, 28)
    expect(await planAnalysisExport({ startMs: START, endMs: END, includeRaw: true }, directory)).toMatchObject({ rawBytes: 128 })
    const sparse = join(directory, 'C.RAW.gz')
    writeFileSync(sparse, '')
    truncateSync(sparse, 2 * 1024 ** 3)
    utimesSync(sparse, START / 1000, START / 1000)
    await expect(planAnalysisExport({ startMs: START, endMs: END, includeRaw: true }, directory)).rejects.toBeInstanceOf(AnalysisExportTooLargeError)
  })
})

it('sizes the tar and builds the download path', () => {
  expect(tarBytes([0, 1, 512, 513])).toBe(1024 + 4 * 512 + 0 + 512 + 512 + 1024)
  expect(analysisExportDownloadPath({ startMs: START, endMs: END, includeRaw: false })).toBe(`/api/biometrics/analysis-export?start=${START}&end=${END}&raw=0`)
})
