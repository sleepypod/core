import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// scripts/lib/ssh-helpers decides where the installer writes root's public
// key. Getting it wrong is an unrecoverable lockout on a real pod (the same
// installer block then sets PasswordAuthentication no), so the resolution
// rules are pinned here rather than trusted to review.
const HELPERS = resolve(process.cwd(), 'scripts/lib/ssh-helpers')

let dir: string

/**
 * Run a snippet with the helpers sourced. `getent` and `sshd` are shadowed by
 * shell functions so the tests describe a pod's environment (root home at
 * /home/root) from a dev machine, which has neither.
 */
function runBash(snippet: string, { rootHome = '/home/root', sshdT = '' } = {}): string {
  const script = `
    set -euo pipefail
    getent() { [ "\${2:-}" = root ] && echo "root:x:0:0:root:${rootHome}:/bin/sh" || return 2; }
    sshd() { ${sshdT ? `printf '%b\\n' ${JSON.stringify(sshdT)}` : 'return 1'}; }
    source ${JSON.stringify(HELPERS)}
    ${snippet}
  `
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ssh-helpers-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolve_authorized_keys_path', () => {
  test('resolves the default relative path against root\'s real home, not /root', () => {
    const config = join(dir, 'sshd_config')
    writeFileSync(config, 'Port 8822\nPermitRootLogin prohibit-password\n')

    const resolved = runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`)

    expect(resolved).toBe('/home/root/.ssh/authorized_keys')
  })

  test('honours an absolute AuthorizedKeysFile pinned by free-sleep', () => {
    const config = join(dir, 'sshd_config')
    writeFileSync(config, 'Port 8822\nAuthorizedKeysFile /home/root/ssh/authorized_keys\n')

    const resolved = runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`)

    expect(resolved).toBe('/home/root/ssh/authorized_keys')
  })

  test('prefers sshd -T over the raw config so an Included directive still wins', () => {
    const config = join(dir, 'sshd_config')
    writeFileSync(config, 'Include /etc/ssh/sshd_config.d/*.conf\n')

    const resolved = runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`, {
      sshdT: 'port 8822\nauthorizedkeysfile /etc/ssh/keys/%u\npermitrootlogin prohibit-password',
    })

    expect(resolved).toBe('/etc/ssh/keys/root')
  })

  test('expands %h and takes the first file when several are listed', () => {
    const config = join(dir, 'sshd_config')
    writeFileSync(config, 'AuthorizedKeysFile %h/.ssh/authorized_keys .ssh/authorized_keys2\n')

    const resolved = runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`)

    expect(resolved).toBe('/home/root/.ssh/authorized_keys')
  })

  test('falls back to /root when the user has no passwd entry', () => {
    const config = join(dir, 'sshd_config')
    writeFileSync(config, 'Port 8822\n')

    const resolved = runBash(
      `getent() { return 2; }; resolve_authorized_keys_path root ${JSON.stringify(config)}`,
    )

    expect(resolved).toBe('/root/.ssh/authorized_keys')
  })
})

describe('install_authorized_key', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY test@example'

  test('creates the key file with modes StrictModes accepts', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(home, { recursive: true })

    const written = runBash(`install_authorized_key root ${JSON.stringify(KEY)}`, { rootHome: home })

    expect(written).toBe(join(home, '.ssh/authorized_keys'))
    expect(readFileSync(written, 'utf8')).toBe(`${KEY}\n`)
    expect(statSync(written).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700)
  })

  test('is idempotent — re-running the installer does not duplicate the key', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(home, { recursive: true })

    runBash(`install_authorized_key root ${JSON.stringify(KEY)}`, { rootHome: home })
    const written = runBash(`install_authorized_key root ${JSON.stringify(KEY)}`, { rootHome: home })

    expect(readFileSync(written, 'utf8')).toBe(`${KEY}\n`)
  })

  test('appends alongside a key that is already enrolled', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh/authorized_keys'), 'ssh-rsa AAAAOLD old@example\n')

    const written = runBash(`install_authorized_key root ${JSON.stringify(KEY)}`, { rootHome: home })

    expect(readFileSync(written, 'utf8')).toBe(`ssh-rsa AAAAOLD old@example\n${KEY}\n`)
  })
})

describe('migrate_stranded_authorized_keys', () => {
  const KEY = 'ssh-rsa AAAASTRANDED jason@mac'

  test('recovers keys the old installer left in /root/.ssh', () => {
    const home = join(dir, 'home', 'root')
    const stranded = join(dir, 'root', '.ssh', 'authorized_keys')
    mkdirSync(home, { recursive: true })
    mkdirSync(join(dir, 'root', '.ssh'), { recursive: true })
    writeFileSync(stranded, `# comment\n\n${KEY}\n`)

    runBash(`migrate_stranded_authorized_keys root ${JSON.stringify(stranded)}`, { rootHome: home })

    expect(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8')).toBe(`${KEY}\n`)
  })

  test('does not duplicate a key that is already in the live file', () => {
    const home = join(dir, 'home', 'root')
    const stranded = join(dir, 'root', '.ssh', 'authorized_keys')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(dir, 'root', '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh/authorized_keys'), `${KEY}\n`)
    writeFileSync(stranded, `${KEY}\n`)

    runBash(`migrate_stranded_authorized_keys root ${JSON.stringify(stranded)}`, { rootHome: home })

    expect(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8')).toBe(`${KEY}\n`)
  })

  test('is a no-op when the stranded file is the live file', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    const live = join(home, '.ssh/authorized_keys')
    writeFileSync(live, `${KEY}\n`)

    runBash(`migrate_stranded_authorized_keys root ${JSON.stringify(live)}`, { rootHome: home })

    expect(readFileSync(live, 'utf8')).toBe(`${KEY}\n`)
  })

  test('is a no-op when there is nothing stranded', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(home, { recursive: true })

    const output = runBash(
      `migrate_stranded_authorized_keys root ${JSON.stringify(join(dir, 'nope'))}; echo done`,
      { rootHome: home },
    )

    expect(output).toBe('done')
  })
})
