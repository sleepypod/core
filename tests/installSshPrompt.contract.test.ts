import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// Runs the installer's real SSH-prompt block, with /dev/tty swapped for a
// file so each case controls whether a terminal exists and what it answers.
const installScript = readFileSync(resolve(process.cwd(), 'scripts/install'), 'utf8')

function slice(from: string, to: string): string {
  const start = installScript.indexOf(from)
  const end = installScript.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`installer block not found: ${from}`)
  return installScript.slice(start, end)
}

const PROMPT_BLOCK = slice('# Optional SSH configuration', 'if [[ "$SETUP_SSH" =~ ^[Yy]$ ]]; then')
const ARG_LOOP = slice('while [ $# -gt 0 ]; do', 'export NODE_MODULES_DIR')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-ssh-prompt-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function prompt(opts: { skip?: boolean, keyArg?: string, tty?: string | null }): string {
  let tty = join(dir, 'no-terminal')
  if (opts.tty != null) {
    tty = join(dir, 'tty')
    writeFileSync(tty, opts.tty)
  }
  const script = `
    set -euo pipefail
    SKIP_SSH=${opts.skip ? 'true' : 'false'}
    SSH_KEY_ARG=${JSON.stringify(opts.keyArg ?? '')}
    ${PROMPT_BLOCK.replaceAll('/dev/tty', tty)}
    echo "SETUP=$SETUP_SSH KEY=$SSH_KEY"
  `
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

describe('installer SSH prompt', () => {
  test('prompts on the terminal even when stdin is the piped script', () => {
    // `curl … | sudo bash` — stdin is the pipe, but there is a terminal.
    const output = prompt({ tty: 'y\n' })

    expect(output).toContain('Optional SSH Configuration')
    expect(output).toMatch(/SETUP=y KEY=$/)
  })

  test('skips with a pointer to --ssh-key when there is no terminal at all', () => {
    const output = prompt({ tty: null })

    expect(output).toContain('re-run with --ssh-key')
    expect(output).toMatch(/SETUP= KEY=$/)
  })

  test('configures SSH from --ssh-key without prompting', () => {
    const output = prompt({ keyArg: 'ssh-ed25519 AAAAKEY me@mac', tty: null })

    expect(output).not.toContain('Optional SSH Configuration')
    expect(output).toMatch(/SETUP=y KEY=ssh-ed25519 AAAAKEY me@mac$/)
  })

  test('--no-ssh wins over --ssh-key', () => {
    const output = prompt({ skip: true, keyArg: 'ssh-ed25519 AAAAKEY me@mac', tty: 'y\n' })

    expect(output).toContain('Skipping SSH setup (--no-ssh)')
    expect(output).toMatch(/^SETUP= /m)
  })

  test('treats an empty answer as no', () => {
    expect(prompt({ tty: '' })).toMatch(/SETUP= KEY=$/)
  })
})

describe('installer --ssh-key flag', () => {
  test('takes the whole key, spaces included, as one argument', () => {
    const script = `
      set -euo pipefail
      SKIP_SSH=false; SSH_KEY_ARG=""; INSTALL_BRANCH=""
      set -- --ssh-key "ssh-ed25519 AAAAKEY me@mac" --branch dev
      ${ARG_LOOP}
      echo "KEY=$SSH_KEY_ARG BRANCH=$INSTALL_BRANCH"
    `
    const output = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()

    expect(output).toBe('KEY=ssh-ed25519 AAAAKEY me@mac BRANCH=dev')
  })
})
