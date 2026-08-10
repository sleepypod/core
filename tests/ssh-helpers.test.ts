import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

// scripts/lib/ssh-helpers decides where the installer writes root's public
// key and whether it is safe to disable password authentication. Getting
// either wrong is an unrecoverable lockout on a real pod, so the rules are
// pinned here rather than trusted to review.
const HELPERS = resolve(process.cwd(), 'scripts/lib/ssh-helpers')

let dir: string
let keyDir: string
let realKey: string

interface RunOptions {
  rootHome?: string
  /** stdout for a plain `sshd -T`; empty means the call fails. */
  sshdT?: string
  /**
   * stdout for `sshd -T -C …`. Omit to mirror `sshdT` (what a modern sshd
   * does); pass `false` to model an older sshd that rejects `-C`.
   */
  sshdTC?: string | false
}

/**
 * Run a snippet with the helpers sourced. `getent` and `sshd` are shadowed by
 * shell functions so the tests can describe a pod's environment (root home at
 * /home/root, Match blocks, ancient sshd) from a dev machine that has neither.
 */
function runBash(snippet: string, { rootHome = '/home/root', sshdT = '', sshdTC }: RunOptions = {}): string {
  const emit = (out: string | false | undefined) =>
    out ? `printf '%b\\n' ${JSON.stringify(out)}` : 'return 1'
  const plain = emit(sshdT)
  const withC = sshdTC === undefined ? plain : emit(sshdTC)

  const script = `
    set -euo pipefail
    getent() { [ "\${2:-}" = root ] && echo "root:x:0:0:root:${rootHome}:/bin/sh" || return 2; }
    sshd() {
      local arg with_c=false
      for arg in "$@"; do [ "$arg" = "-C" ] && with_c=true; done
      if [ "$with_c" = true ]; then ${withC}; else ${plain}; fi
    }
    source ${JSON.stringify(HELPERS)}
    ${snippet}
  `
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()
}

function writeConfig(contents: string): string {
  const path = join(dir, 'sshd_config')
  writeFileSync(path, contents)
  return path
}

beforeAll(() => {
  // A real, parseable key — the whole point of validate_public_key is that
  // a hand-written lookalike is not good enough.
  keyDir = mkdtempSync(join(tmpdir(), 'ssh-helpers-key-'))
  const keyPath = join(keyDir, 'id_ed25519')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'test@example', '-f', keyPath], {
    stdio: 'ignore',
  })
  realKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
})

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true })
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ssh-helpers-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolve_authorized_keys_path', () => {
  test('resolves the default relative path against root\'s real home, not /root', () => {
    const config = writeConfig('Port 8822\nPermitRootLogin prohibit-password\n')

    expect(runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`))
      .toBe('/home/root/.ssh/authorized_keys')
  })

  test('honours an absolute AuthorizedKeysFile pinned by free-sleep', () => {
    const config = writeConfig('Port 8822\nAuthorizedKeysFile /home/root/ssh/authorized_keys\n')

    expect(runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`))
      .toBe('/home/root/ssh/authorized_keys')
  })

  test('prefers sshd -T over the raw config so an Included directive still wins', () => {
    const config = writeConfig('Include /etc/ssh/sshd_config.d/*.conf\n')

    expect(runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`, {
      sshdT: 'port 8822\nauthorizedkeysfile /etc/ssh/keys/%u\npermitrootlogin prohibit-password',
    })).toBe('/etc/ssh/keys/root')
  })

  test('applies a Match User root override, which only -C surfaces', () => {
    const config = writeConfig('AuthorizedKeysFile .ssh/authorized_keys\nMatch User root\n  AuthorizedKeysFile none\n')

    expect(runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`, {
      sshdT: 'authorizedkeysfile .ssh/authorized_keys',
      sshdTC: 'authorizedkeysfile none',
    })).toBe('none')
  })

  test('falls back to a plain sshd -T when the installed sshd rejects -C', () => {
    const config = writeConfig('Include /etc/ssh/sshd_config.d/*.conf\n')

    expect(runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`, {
      sshdT: 'authorizedkeysfile /etc/ssh/keys/%u',
      sshdTC: false,
    })).toBe('/etc/ssh/keys/root')
  })

  test('expands %U to the target uid', () => {
    const config = writeConfig('AuthorizedKeysFile /etc/ssh/keys/%U/authorized_keys\n')

    expect(runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`))
      .toBe('/etc/ssh/keys/0/authorized_keys')
  })

  test('keeps a literal %% from being eaten by the %h pass', () => {
    const config = writeConfig('AuthorizedKeysFile /etc/ssh/%%h/authorized_keys\n')

    expect(runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`))
      .toBe('/etc/ssh/%h/authorized_keys')
  })

  test('expands %h and takes the first file when several are listed', () => {
    const config = writeConfig('AuthorizedKeysFile %h/.ssh/authorized_keys .ssh/authorized_keys2\n')

    expect(runBash(`resolve_authorized_keys_path root ${JSON.stringify(config)}`))
      .toBe('/home/root/.ssh/authorized_keys')
  })

  test('falls back to /root when the user has no passwd entry', () => {
    const config = writeConfig('Port 8822\n')

    expect(runBash(`getent() { return 2; }; resolve_authorized_keys_path root ${JSON.stringify(config)}`))
      .toBe('/root/.ssh/authorized_keys')
  })
})

describe('validate_public_key', () => {
  test('accepts a key ssh-keygen can parse', () => {
    expect(runBash(`validate_public_key ${JSON.stringify(realKey)} && echo ok`)).toBe('ok')
  })

  test('rejects a well-shaped but unparseable key the old regex allowed', () => {
    // `ssh-ed25519 A` matched the previous format check and would have been
    // installed, then password auth disabled against it.
    const snippet = 'status=0; validate_public_key "ssh-ed25519 A" || status=$?; echo "$status"'

    expect(runBash(snippet)).toBe('1')
  })

  test('reports "cannot tell" rather than success when ssh-keygen is missing', () => {
    const snippet = `PATH=/var/empty; status=0; validate_public_key ${JSON.stringify(realKey)} || status=$?; echo "$status"`

    expect(runBash(snippet)).toBe('2')
  })
})

describe('install_authorized_key', () => {
  test('creates the key file with modes StrictModes accepts', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(home, { recursive: true })

    const written = runBash(`install_authorized_key root ${JSON.stringify(realKey)}`, { rootHome: home })

    expect(written).toBe(join(home, '.ssh/authorized_keys'))
    expect(readFileSync(written, 'utf8')).toBe(`${realKey}\n`)
    expect(statSync(written).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700)
  })

  test('is idempotent — re-running the installer does not duplicate the key', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(home, { recursive: true })

    runBash(`install_authorized_key root ${JSON.stringify(realKey)}`, { rootHome: home })
    const written = runBash(`install_authorized_key root ${JSON.stringify(realKey)}`, { rootHome: home })

    expect(readFileSync(written, 'utf8')).toBe(`${realKey}\n`)
  })

  test('appends alongside a key that is already enrolled', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh/authorized_keys'), 'ssh-rsa AAAAOLD old@example\n')

    const written = runBash(`install_authorized_key root ${JSON.stringify(realKey)}`, { rootHome: home })

    expect(readFileSync(written, 'utf8')).toBe(`ssh-rsa AAAAOLD old@example\n${realKey}\n`)
  })

  test('refuses to invent a path when AuthorizedKeysFile is none', () => {
    const snippet = `install_authorized_key root ${JSON.stringify(realKey)} 2>/dev/null || echo REFUSED`

    expect(runBash(snippet, { sshdT: 'authorizedkeysfile none' })).toBe('REFUSED')
  })

  test('fails rather than reporting success when the key cannot be written', () => {
    // The call site runs this inside an `if`, which suppresses set -e for the
    // whole function — an unchecked mkdir would fall through to the final
    // printf and the installer would disable password auth against a key that
    // never reached disk.
    const home = join(dir, 'home', 'root')
    mkdirSync(home, { recursive: true })
    chmodSync(home, 0o555)

    const snippet = `install_authorized_key root ${JSON.stringify(realKey)} 2>/dev/null || echo REFUSED`
    const output = runBash(snippet, { rootHome: home })
    chmodSync(home, 0o755)

    expect(output).toBe('REFUSED')
  })
})

describe('migrate_stranded_authorized_keys', () => {
  const OLD_KEY = 'ssh-rsa AAAASTRANDED jason@mac'

  function strandedPath(): string {
    mkdirSync(join(dir, 'root', '.ssh'), { recursive: true })
    return join(dir, 'root', '.ssh', 'authorized_keys')
  }

  test('recovers keys the old installer left in /root/.ssh', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(home, { recursive: true })
    const stranded = strandedPath()
    writeFileSync(stranded, `# comment\n\n${OLD_KEY}\n`)

    runBash(`migrate_stranded_authorized_keys root ${JSON.stringify(stranded)}`, { rootHome: home })

    expect(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8')).toBe(`${OLD_KEY}\n`)
  })

  test('recovers a final key with no trailing newline', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(home, { recursive: true })
    const stranded = strandedPath()
    writeFileSync(stranded, `${OLD_KEY}`)

    runBash(`migrate_stranded_authorized_keys root ${JSON.stringify(stranded)}`, { rootHome: home })

    expect(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8')).toBe(`${OLD_KEY}\n`)
  })

  test('does not duplicate a key that is already in the live file', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    const stranded = strandedPath()
    writeFileSync(join(home, '.ssh/authorized_keys'), `${OLD_KEY}\n`)
    writeFileSync(stranded, `${OLD_KEY}\n`)

    runBash(`migrate_stranded_authorized_keys root ${JSON.stringify(stranded)}`, { rootHome: home })

    expect(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8')).toBe(`${OLD_KEY}\n`)
  })

  test('is a no-op when the stranded file is the live file', () => {
    const home = join(dir, 'home', 'root')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    const live = join(home, '.ssh/authorized_keys')
    writeFileSync(live, `${OLD_KEY}\n`)

    runBash(`migrate_stranded_authorized_keys root ${JSON.stringify(live)}`, { rootHome: home })

    expect(readFileSync(live, 'utf8')).toBe(`${OLD_KEY}\n`)
  })

  test('is a no-op when key files are disabled entirely', () => {
    const stranded = strandedPath()
    writeFileSync(stranded, `${OLD_KEY}\n`)

    const output = runBash(
      `migrate_stranded_authorized_keys root ${JSON.stringify(stranded)}; echo done`,
      { sshdT: 'authorizedkeysfile none' },
    )

    expect(output).toBe('done')
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

describe('set_sshd_directive', () => {
  function applied(contents: string, key: string, value: string): string {
    const config = writeConfig(contents)
    runBash(`set_sshd_directive ${key} ${value} ${JSON.stringify(config)}`)
    return readFileSync(config, 'utf8')
  }

  test('overwrites an active directive', () => {
    expect(applied('Port 22\nX11Forwarding yes\n', 'Port', '8822'))
      .toBe('Port 8822\nX11Forwarding yes\n')
  })

  test('uncomments and sets a commented-out directive', () => {
    expect(applied('#PasswordAuthentication yes\n', 'PasswordAuthentication', 'no'))
      .toBe('PasswordAuthentication no\n')
  })

  test('appends the directive when the config never mentions it', () => {
    // The substitution this replaced was a silent no-op here, leaving sshd on
    // its default (PasswordAuthentication yes) while reporting success.
    expect(applied('Port 8822\n', 'PermitEmptyPasswords', 'no'))
      .toBe('Port 8822\nPermitEmptyPasswords no\n')
  })

  test('inserts above the first Match block instead of inside it', () => {
    expect(applied('Port 8822\nMatch User dac\n  X11Forwarding no\n', 'PasswordAuthentication', 'no'))
      .toBe('Port 8822\nPasswordAuthentication no\nMatch User dac\n  X11Forwarding no\n')
  })

  test('replaces the Key=value form sshd also accepts', () => {
    // Left in place, a stale `=`-form directive earlier in the file would win
    // over an appended one, since sshd takes the first occurrence.
    expect(applied('PasswordAuthentication=yes\n', 'PasswordAuthentication', 'no'))
      .toBe('PasswordAuthentication no\n')
  })

  test('replaces a commented Key=value directive', () => {
    expect(applied('#PermitEmptyPasswords=yes\n', 'PermitEmptyPasswords', 'no'))
      .toBe('PermitEmptyPasswords no\n')
  })

  test('leaves the directive name in prose alone', () => {
    // An unanchored substitution rewrote this comment into `# Port 8822`.
    expect(applied('# Port forwarding is disabled below\nPort 22\n', 'Port', '8822'))
      .toBe('# Port forwarding is disabled below\nPort 8822\n')
  })
})

describe('sshd_effective_value', () => {
  test('reads the value sshd will actually use', () => {
    const config = writeConfig('Port 8822\n')

    expect(runBash(`sshd_effective_value PasswordAuthentication ${JSON.stringify(config)}`, {
      sshdT: 'port 8822\npasswordauthentication no',
    })).toBe('no')
  })

  test('prints nothing when sshd cannot report a value', () => {
    const config = writeConfig('Port 8822\n')

    expect(runBash(`echo "[$(sshd_effective_value PasswordAuthentication ${JSON.stringify(config)})]"`))
      .toBe('[]')
  })
})
