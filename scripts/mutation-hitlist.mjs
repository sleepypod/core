#!/usr/bin/env node
// Generate an actionable "surviving mutants" hit list from Stryker's
// mutation.json output(s). Runs locally (`pnpm test:mutation && node
// scripts/mutation-hitlist.mjs`) or in CI (reads multiple shard reports
// from a directory structure like shards/mutation-report-<name>/mutation.json).
//
// Intentionally does NOT attempt to auto-generate tests — mutation
// testing exists to catch tautological assertions, so an agent writing
// the killing tests should operate on this hit list as input, not have
// it baked into the same pipeline.
//
// Usage:
//   node scripts/mutation-hitlist.mjs                        # reads reports/mutation/mutation.json
//   node scripts/mutation-hitlist.mjs shards/                # aggregates shards/**/mutation.json
//   node scripts/mutation-hitlist.mjs path/to/mutation.json  # explicit single file
//
// Outputs Markdown to stdout and writes reports/mutation/hitlist.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const DEFAULT_REPORT = join(ROOT, 'reports/mutation/mutation.json')
const OUT_PATH = join(ROOT, 'reports/mutation/hitlist.md')
const TOP_N = 50 // cap length of the surviving-mutants detail list

// ── report discovery ──────────────────────────────────────────────────────

/** Walk a directory tree for mutation.json files. */
function findReports(dir) {
  const found = []
  function walk(p) {
    const entries = readdirSync(p)
    for (const name of entries) {
      const full = join(p, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (name === 'mutation.json') found.push(full)
    }
  }
  walk(dir)
  return found
}

function loadReports(arg) {
  if (!arg) return existsSync(DEFAULT_REPORT) ? [DEFAULT_REPORT] : []
  const p = resolve(arg)
  const st = existsSync(p) ? statSync(p) : null
  if (!st) {
    console.error(`No such path: ${p}`)
    process.exit(1)
  }
  return st.isDirectory() ? findReports(p) : [p]
}

// ── parsing ───────────────────────────────────────────────────────────────

/**
 * Merge multiple Stryker reports into one {file: mutants[]} map.
 * Preserves source for snippet extraction; later reports win on conflict.
 */
function mergeReports(paths) {
  const merged = {}
  for (const p of paths) {
    let data
    try {
      data = JSON.parse(readFileSync(p, 'utf8'))
    }
    catch (err) {
      console.error(`[hitlist] skipping ${p}: ${err.message}`)
      continue
    }
    for (const [file, entry] of Object.entries(data.files ?? {})) {
      if (!merged[file]) merged[file] = { source: entry.source, mutants: [] }
      for (const m of entry.mutants ?? []) merged[file].mutants.push(m)
    }
  }
  return merged
}

function tally(merged) {
  const counts = { Killed: 0, Survived: 0, NoCoverage: 0, Timeout: 0, CompileError: 0, RuntimeError: 0 }
  let total = 0
  for (const { mutants } of Object.values(merged)) {
    for (const m of mutants) {
      counts[m.status] = (counts[m.status] ?? 0) + 1
      total++
    }
  }
  const base = counts.Killed + counts.Survived + counts.Timeout + counts.NoCoverage
  const score = base > 0 ? (counts.Killed / base) * 100 : null
  return { total, counts, score }
}

/** Extract the N lines centered on a mutant's location, with line numbers. */
function snippet(source, loc, context = 1) {
  if (!source || !loc?.start) return ''
  const lines = source.split('\n')
  const start = Math.max(0, loc.start.line - 1 - context)
  const end = Math.min(lines.length, (loc.end?.line ?? loc.start.line) + context)
  const out = []
  for (let i = start; i < end; i++) {
    const marker = i === loc.start.line - 1 ? '>' : ' '
    out.push(`${marker} ${String(i + 1).padStart(4)} | ${lines[i] ?? ''}`)
  }
  return out.join('\n')
}

/** Guess the most likely test file that should have covered a source file. */
function guessTestFile(sourceFile) {
  // src/foo/bar.ts → src/foo/tests/bar.test.ts (matches our layout)
  const m = sourceFile.match(/^(.*)\/([^/]+)\.tsx?$/)
  if (!m) return null
  return `${m[1]}/tests/${m[2]}.test.ts`
}

// ── formatting ────────────────────────────────────────────────────────────

function formatHitlist(merged) {
  const { total, counts, score } = tally(merged)
  const scoreStr = score == null ? '—' : `${score.toFixed(1)}%`

  const surviving = []
  for (const [file, { source, mutants }] of Object.entries(merged)) {
    const s = mutants.filter(m => m.status === 'Survived')
    if (s.length > 0) surviving.push({ file, source, mutants: s })
  }
  surviving.sort((a, b) => b.mutants.length - a.mutants.length)

  const lines = []
  lines.push('# Mutation testing — hit list')
  lines.push('')
  lines.push(`**Score:** ${scoreStr}  ·  **Total mutants:** ${total}`)
  lines.push('')
  lines.push(`| Status | Count |`)
  lines.push(`| --- | ---: |`)
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) lines.push(`| ${k} | ${v} |`)
  }
  lines.push('')

  if (surviving.length === 0) {
    lines.push('All covered mutants killed. 🎉')
    return lines.join('\n')
  }

  lines.push(`## Surviving mutants by file (${surviving.length} files, top ${TOP_N} mutants shown)`)
  lines.push('')
  lines.push('For each entry below: the mutator type tells you **what** Stryker changed, the snippet shows **where**, and "expected test" is the most likely location to add a killing assertion. A killing test must **fail** when the mutation is applied.')
  lines.push('')

  let shown = 0
  for (const { file, source, mutants } of surviving) {
    if (shown >= TOP_N) break
    const rel = relative(ROOT, resolve(file))
    const testFile = guessTestFile(rel)
    lines.push(`### \`${rel}\` — ${mutants.length} surviving`)
    if (testFile) lines.push(`Expected test file: \`${testFile}\``)
    lines.push('')
    for (const m of mutants) {
      if (shown >= TOP_N) break
      shown++
      const loc = m.location ?? {}
      lines.push(`<details><summary><code>${m.mutatorName}</code> at line ${loc.start?.line ?? '?'}</summary>`)
      lines.push('')
      lines.push('```diff')
      const before = snippet(source, loc).split('\n')
      lines.push(...before)
      if (m.replacement) {
        lines.push('')
        lines.push(`+ (mutation): ${m.replacement.replace(/\n/g, ' ⏎ ').slice(0, 200)}`)
      }
      lines.push('```')
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
  }

  const extra = surviving.reduce((n, { mutants }) => n + mutants.length, 0) - shown
  if (extra > 0) {
    lines.push(`*…and ${extra} more surviving mutants not shown. See the HTML report for the full list.*`)
  }
  return lines.join('\n')
}

// ── main ──────────────────────────────────────────────────────────────────

const reports = loadReports(process.argv[2])
if (reports.length === 0) {
  console.error('[hitlist] no mutation.json found. Run `pnpm test:mutation` first.')
  process.exit(1)
}

console.error(`[hitlist] reading ${reports.length} report(s): ${reports.map(r => relative(ROOT, r)).join(', ')}`)
const merged = mergeReports(reports)
const md = formatHitlist(merged)
mkdirSync(join(ROOT, 'reports/mutation'), { recursive: true })
writeFileSync(OUT_PATH, md)
console.error(`[hitlist] wrote ${relative(ROOT, OUT_PATH)}`)
process.stdout.write(md + '\n')
