#!/usr/bin/env node
// Plan the mutation-testing job matrix for .github/workflows/mutation.yml.
//
// Each shard is split into `parts` jobs of roughly equal weight so every
// job finishes inside the 90-min timeout. A timed-out job never writes
// Stryker's incremental.json, so an oversized shard restarts from zero
// every week and never produces a report — splitting is the only way out.
//
// Files are walked in path order and cut only between top-level
// statements. Stryker mutates a node only when it lies entirely inside a
// `file:startLine-endLine` range, so a cut through a function would drop
// every mutant spanning the cut from both parts.
//
// Usage:
//   node scripts/mutation-plan.mjs            # full matrix JSON on stdout
//   node scripts/mutation-plan.mjs '<globs>'  # one `custom` job for a manual scope
//
// Per-part weights go to stderr.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Keep dirs in sync with stryker.config.mjs's mutate: block. `parts` was
// sized from run 44913797057's projected runtimes (elapsed + remaining at
// the 90-min cancel) to ~40 min of mutant testing per part:
// biometrics ~17h, db ~7.5h, streaming ~5.4h, server ~4.4h,
// hardware-lib ~3.8h, services-scheduler ~1.7h, hooks 51m, homekit 18m.
const SHARDS = [
  { name: 'services-scheduler', dirs: ['src/services', 'src/scheduler'], exts: ['.ts'], parts: 3 },
  { name: 'hardware-lib', dirs: ['src/hardware', 'src/lib'], exts: ['.ts'], parts: 6 },
  { name: 'homekit', dirs: ['src/homekit'], exts: ['.ts'], parts: 1 },
  { name: 'server', dirs: ['src/server'], exts: ['.ts'], parts: 7 },
  { name: 'streaming', dirs: ['src/streaming'], exts: ['.ts'], parts: 8 },
  { name: 'hooks', dirs: ['src/hooks'], exts: ['.ts', '.tsx'], parts: 2 },
  { name: 'biometrics', dirs: ['src/biometrics'], exts: ['.ts'], parts: 26 },
  { name: 'db', dirs: ['src/db'], exts: ['.ts'], parts: 12 },
]

// Statements Stryker never mutates; they carry no weight.
const WEIGHTLESS = new Set([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
])

function listFiles({ dirs, exts }) {
  return execFileSync('git', ['ls-files', '--', ...dirs], { encoding: 'utf8' })
    .split('\n')
    .filter(f => exts.some(e => f.endsWith(e)))
    .filter(f => !f.includes('/tests/') && !/\.test\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
    .sort()
}

/** Top-level statements of a file as {file, start, end, weight} (1-based lines). */
function units(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  return sf.statements.map((s) => {
    const start = sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1
    const end = sf.getLineAndCharacterOfPosition(s.getEnd()).line + 1
    const weight = WEIGHTLESS.has(s.kind)
      ? 0
      : lines.slice(start - 1, end).filter(l => l.trim() !== '').length
    return { file, start, end, weight, lastLine: lines.length }
  })
}

/** Assign each unit to the part containing its weight midpoint. */
function partition(all, parts) {
  const total = all.reduce((n, u) => n + u.weight, 0)
  const target = total / parts
  const out = [[]]
  let cum = 0
  let prev = null
  for (const u of all) {
    const k = out.length - 1
    const canCut = !prev || prev.file !== u.file || prev.end < u.start
    if (out[k].length > 0 && canCut && k < parts - 1 && cum + u.weight / 2 > (k + 1) * target) {
      out.push([])
    }
    out[out.length - 1].push(u)
    cum += u.weight
    prev = u
  }
  return out
}

/** Collapse a part's units to Stryker mutate patterns; whole files stay plain paths. */
function patterns(part, fileUnits) {
  const byFile = new Map()
  for (const u of part) {
    if (!byFile.has(u.file)) byFile.set(u.file, [])
    byFile.get(u.file).push(u)
  }
  return [...byFile].map(([file, us]) => {
    const all = fileUnits.get(file)
    if (us.length === all.length) return file
    const first = us[0]
    const last = us[us.length - 1]
    const start = first === all[0] ? 1 : first.start
    const end = last === all[all.length - 1] ? last.lastLine : last.end
    return `${file}:${start}-${end}`
  })
}

function plan() {
  const include = []
  for (const shard of SHARDS) {
    const all = listFiles(shard).flatMap(units)
    const fileUnits = Map.groupBy(all, u => u.file)
    const parts = partition(all, shard.parts)
    parts.forEach((part, i) => {
      const name = shard.parts === 1 ? shard.name : `${shard.name}--${String(i + 1).padStart(2, '0')}`
      const weight = part.reduce((n, u) => n + u.weight, 0)
      console.error(`[plan] ${name}: weight ${weight}, ${new Set(part.map(u => u.file)).size} file(s)`)
      include.push({ name, mutate: patterns(part, fileUnits).join(',') })
    })
  }
  return { include }
}

const scope = (process.argv[2] ?? '').trim()
const matrix = scope ? { include: [{ name: 'custom', mutate: scope }] } : plan()
process.stdout.write(JSON.stringify(matrix) + '\n')
