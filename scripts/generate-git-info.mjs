#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const run = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf-8' }).trim() }
  catch { return 'unknown' }
}

try {
  writeFileSync('.git-info', JSON.stringify({
    branch: run('git rev-parse --abbrev-ref HEAD'),
    commitHash: run('git rev-parse --short HEAD'),
    commitTitle: run('git log -1 --format=%s'),
    buildDate: new Date().toISOString(),
  }))
  console.log('Generated .git-info')
}
catch (err) {
  console.warn('Could not write .git-info (non-fatal):', err.message)
}
