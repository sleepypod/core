/* Only in-memory SQLite and image encoding: never import the application or hardware. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import process from 'node:process'
import Database from 'better-sqlite3'

async function main() {
  assert.equal(process.platform, 'linux')
  assert.equal(process.arch, 'arm64')
  assert.equal(process.versions.node, '24.22.1')
  assert.equal(process.versions.modules, '137')
  // Resolve Next's image dependency from its own package, as its optimizer does.
  const require = createRequire(import.meta.url)
  const sharp = createRequire(require.resolve('next/package.json'))('sharp')
  const database = new Database(':memory:')
  try {
    assert.equal(database.prepare('SELECT 17 AS result').get().result, 17)
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok')
  }
  finally { database.close() }
  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).png().toBuffer()
  assert.equal((await sharp(image).metadata()).width, 1)
  process.stdout.write(`${JSON.stringify({ platform: process.platform, architecture: process.arch,
    node: process.versions.node, sqlite: 'ok', imageCodec: 'ok', applicationStarted: false })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
