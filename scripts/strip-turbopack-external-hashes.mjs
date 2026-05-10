#!/usr/bin/env node
// Turbopack standalone builds bake content-hashed external module ids into
// chunks (e.g. require("better-sqlite3-0cddb9bd3059e7dc")). At runtime, the
// pod's node_modules has the bare package name, so the require throws
// "Cannot find module". Strip the -<16hex> suffix from references to any
// package that resolves under node_modules.
//
// Runs after `next build` against `.next/server/chunks/` and any
// `.next/standalone/.next/server/chunks/` output. Exits non-zero if a
// hashed reference to a known package survives the rewrite.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const NODE_MODULES = join(ROOT, 'node_modules')
const TARGETS = [
  '.next/server/chunks',
  '.next/standalone/.next/server/chunks',
]
const HASH = '[a-f0-9]{16}'

function listPackages() {
  const set = new Set()
  if (!existsSync(NODE_MODULES)) return set
  for (const entry of readdirSync(NODE_MODULES, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scope = join(NODE_MODULES, entry.name)
      for (const sub of readdirSync(scope, { withFileTypes: true })) {
        if (sub.name.startsWith('.')) continue
        set.add(`${entry.name}/${sub.name}`)
      }
    }
    else {
      set.add(entry.name)
    }
  }
  return set
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function* walkJs(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJs(p)
    else if (entry.isFile() && entry.name.endsWith('.js')) yield p
  }
}

const packages = listPackages()
if (packages.size === 0) {
  console.error('[strip-hashes] node_modules empty; aborting')
  process.exit(1)
}

// Sort longest-first so "better-sqlite3" matches before "better".
const sorted = [...packages].sort((a, b) => b.length - a.length)
const replacers = sorted.map(pkg => ({
  pkg,
  re: new RegExp(`${escapeRegex(pkg)}-${HASH}\\b`, 'g'),
}))

let filesChanged = 0
let refsRewritten = 0

for (const target of TARGETS) {
  for (const file of walkJs(target)) {
    const original = readFileSync(file, 'utf8')
    let next = original
    for (const { pkg, re } of replacers) {
      next = next.replace(re, () => {
        refsRewritten++
        return pkg
      })
    }
    if (next !== original) {
      writeFileSync(file, next)
      filesChanged++
    }
  }
}

console.log(
  `[strip-hashes] rewrote ${refsRewritten} reference(s) across ${filesChanged} file(s)`,
)

// Verify: any surviving `<known-pkg>-<16hex>` is a regression.
const survivors = []
const verifyRe = new RegExp(
  `(?<![\\w./@-])([@\\w][\\w./@-]*?)-(${HASH})\\b`,
  'g',
)
for (const target of TARGETS) {
  for (const file of walkJs(target)) {
    const content = readFileSync(file, 'utf8')
    for (const m of content.matchAll(verifyRe)) {
      if (packages.has(m[1])) {
        survivors.push({ file, match: m[0] })
        if (survivors.length >= 20) break
      }
    }
    if (survivors.length >= 20) break
  }
  if (survivors.length >= 20) break
}

if (survivors.length > 0) {
  console.error(
    `[strip-hashes] ERROR: ${survivors.length} hashed reference(s) survived rewrite:`,
  )
  for (const s of survivors) console.error(`  ${s.file}: ${s.match}`)
  process.exit(1)
}
