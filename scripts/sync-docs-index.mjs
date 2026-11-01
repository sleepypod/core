#!/usr/bin/env node
// Refreshes the docs search snapshot bundled with the command palette.
// Pods often have internet blocked, so the palette searches this copy and
// only swaps in the live index when the browser can reach the docs site.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DOCS_INDEX_URL, isDocsIndex } from '../src/components/Search/docsIndex.ts'

const out = fileURLToPath(new URL('../src/components/Search/docsIndex.json', import.meta.url))

const res = await fetch(DOCS_INDEX_URL, { signal: AbortSignal.timeout(30_000) })
if (!res.ok) {
  console.error(`${DOCS_INDEX_URL} returned HTTP ${res.status}`)
  process.exit(1)
}
const index = await res.json()
if (!isDocsIndex(index)) {
  console.error(`${DOCS_INDEX_URL} does not match the version 1 search index contract; snapshot left unchanged`)
  process.exit(1)
}

writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`)
console.log(`Wrote ${index.pages.length} docs pages (generated ${index.generatedAt}) to ${out}`)
