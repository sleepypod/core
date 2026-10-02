import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { demoRouters } from '../handlers'

const ROOT = path.resolve(__dirname, '../../..')
const SCAN_DIRS = ['src', 'app']
const SKIP = new Set(['tests', 'node_modules', 'demo', 'server'])

// Hook and imperative-client call sites: trpc.x.y.useQuery(...), utils.x.y.fetch(...)
const CALL_SITE = /\b(?:trpc|utils)\.([a-zA-Z]+)\.([a-zA-Z]+)\.(?:use(?:Suspense)?Query|useMutation|useInfiniteQuery|fetch|ensureData)\b/g

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, files)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full)
  }
  return files
}

function uiProcedures(): string[] {
  const found = new Set<string>()
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      for (const [, router, procedure] of readFileSync(file, 'utf8').matchAll(CALL_SITE)) {
        found.add(`${router}.${procedure}`)
      }
    }
  }
  return [...found].sort()
}

describe('demo handlers', () => {
  it('cover every procedure the UI calls', () => {
    const procedures = uiProcedures()
    expect(procedures.length).toBeGreaterThan(50)

    const missing = procedures.filter((p) => {
      const [router, procedure] = p.split('.')
      const handlers = demoRouters[router as keyof typeof demoRouters] as Record<string, unknown> | undefined
      return typeof handlers?.[procedure] !== 'function'
    })
    expect(missing).toEqual([])
  })
})
