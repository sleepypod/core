#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim()
  }
  catch {
    return 'unknown'
  }
}

const branch = process.env.SP_BRANCH || run('git rev-parse --abbrev-ref HEAD')

try {
  // If SP_BRANCH is set and a .git-info already exists (e.g. from CI build),
  // patch the branch in-place to preserve the correct commitHash/commitTitle.
  if (process.env.SP_BRANCH) {
    let existing = {}
    try { existing = JSON.parse(readFileSync('.git-info', 'utf-8')) } catch {}
    writeFileSync('.git-info', JSON.stringify({
      ...existing,
      branch,
      buildDate: new Date().toISOString(),
    }))
  }
  else {
    writeFileSync('.git-info', JSON.stringify({
      branch,
      commitHash: run('git rev-parse --short HEAD'),
      commitTitle: run('git log -1 --format=%s'),
      buildDate: new Date().toISOString(),
    }))
  }
  console.log('Generated .git-info')
}
catch (err) {
  console.warn('Could not write .git-info (non-fatal):', err.message)
}
