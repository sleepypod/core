// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve('scripts/bin/sp-storage-cleanup')

let root: string
let persistent: string
let home: string
let dataDir: string

/** Make a directory with a file in it, optionally backdated by `ageSec`. */
function dir(path: string, ageSec = 0): string {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'f'), 'x'.repeat(4096))
  if (ageSec) {
    const t = Date.now() / 1000 - ageSec
    utimesSync(path, t, t)
  }
  return path
}

function file(path: string, ageSec = 0): string {
  writeFileSync(path, 'x'.repeat(4096))
  const t = Date.now() / 1000 - ageSec
  utimesSync(path, t, t)
  return path
}

function run(args: string[] = []) {
  const res = spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PERSISTENT_ROOT: persistent,
      INSTALL_DIR: join(home, 'sleepypod-core'),
      DATA_DIR: dataDir,
      FSTAB: join(root, 'fstab'),
    },
  })
  return res
}

function plan(args: string[] = []): Array<{ path: string, bytes: number, reason: string }> {
  const res = run(['--dry-run', '--json', ...args])
  expect(res.status, res.stderr).toBe(0)
  return JSON.parse(res.stdout).items
}

const names = (items: Array<{ path: string }>) => items.map(i => i.path.slice(persistent.length + 1)).sort()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sp-storage-')))
  persistent = join(root, 'persistent')
  home = join(root, 'home')
  dataDir = join(persistent, 'sleepypod-data')
  mkdirSync(home, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  // Live install is a symlink into a release dir, as on the dev Pod.
  const live = dir(join(persistent, 'sleepypod-releases', 'live'), 50)
  dir(join(live, 'node_modules'))
  symlinkSync(live, join(home, 'sleepypod-core'))
  dir(join(persistent, 'sleepypod-releases', 'old-a'), 400)
  dir(join(persistent, 'sleepypod-releases', 'old-b'), 300)
  dir(join(persistent, 'sleepypod-releases', 'newer'), 100)
  // Must never be touched.
  dir(join(persistent, 'biometrics-archive'), 99999)
  dir(join(persistent, 'homekit'), 99999)
  file(join(persistent, 'swapfile'), 99999)
  file(join(dataDir, 'biometrics.db'), 99999)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('sp-storage-cleanup', () => {
  it('keeps the live release and the newest other, and lists the rest', () => {
    expect(names(plan())).toEqual(['sleepypod-releases/old-a', 'sleepypod-releases/old-b'])
  })

  it('lists stale staging and rollback dirs, but not fresh ones or the excluded one', () => {
    dir(join(persistent, 'sleepypod-rollback.OLD'), 7200)
    dir(join(persistent, 'sleepypod-rollback.NEW'), 60)
    const current = dir(join(persistent, 'sleepypod-rollback.CUR'), 7200)
    dir(join(persistent, 'sleepypod-update-tmp'), 7200)
    dir(join(persistent, 'sleepypod-deploy-pr677-abc'), 7200)
    expect(names(plan(['--only', 'temp', '--exclude', current]))).toEqual([
      'sleepypod-deploy-pr677-abc', 'sleepypod-rollback.OLD', 'sleepypod-update-tmp',
    ])
  })

  it('lists relocated node_modules only when the install no longer uses it', () => {
    dir(join(persistent, 'sleepypod-core', 'node_modules'))
    expect(names(plan())).toContain('sleepypod-core/node_modules')
  })

  it('keeps relocated node_modules when the install resolves to it', () => {
    const nm = dir(join(persistent, 'sleepypod-core', 'node_modules'))
    const live = join(persistent, 'sleepypod-releases', 'live', 'node_modules')
    rmSync(live, { recursive: true })
    symlinkSync(nm, live)
    expect(names(plan())).not.toContain('sleepypod-core/node_modules')
  })

  it('keeps relocated node_modules when fstab bind-mounts it', () => {
    const nm = dir(join(persistent, 'sleepypod-core', 'node_modules'))
    writeFileSync(join(root, 'fstab'), `${nm} /home/dac/sleepypod-core/node_modules none bind,nofail 0 0\n`)
    expect(names(plan())).not.toContain('sleepypod-core/node_modules')
  })

  it('only lists database backups with the flag, keeping the newest', () => {
    file(join(dataDir, 'biometrics.db.bak.1'), 900)
    file(join(dataDir, 'biometrics.db.bak.2'), 500)
    file(join(dataDir, 'biometrics.db.pre-uv-backup'), 1000)
    expect(names(plan())).not.toContain('sleepypod-data/biometrics.db.bak.1')
    expect(names(plan(['--include-db-backups']))).toEqual(expect.arrayContaining([
      'sleepypod-data/biometrics.db.bak.1', 'sleepypod-data/biometrics.db.pre-uv-backup',
    ]))
    expect(names(plan(['--include-db-backups']))).not.toContain('sleepypod-data/biometrics.db.bak.2')
  })

  it('reports sizes and freed bytes as JSON', () => {
    const res = run(['--dry-run', '--json'])
    const out = JSON.parse(res.stdout)
    expect(out.dryRun).toBe(true)
    expect(out.items[0].bytes).toBeGreaterThan(0)
    expect(out.freedBytes).toBe(out.items.reduce((s: number, i: { bytes: number }) => s + i.bytes, 0))
  })

  it('dry run deletes nothing; a real run deletes only listed paths', () => {
    run(['--dry-run'])
    expect(existsSync(join(persistent, 'sleepypod-releases', 'old-a'))).toBe(true)
    const res = run(['--json'])
    expect(res.status, res.stderr).toBe(0)
    expect(JSON.parse(res.stdout).dryRun).toBe(false)
    expect(existsSync(join(persistent, 'sleepypod-releases', 'old-a'))).toBe(false)
    expect(existsSync(join(persistent, 'sleepypod-releases', 'old-b'))).toBe(false)
    for (const keep of ['sleepypod-releases/live', 'sleepypod-releases/newer', 'biometrics-archive', 'homekit', 'swapfile', 'sleepypod-data/biometrics.db']) {
      expect(existsSync(join(persistent, keep)), keep).toBe(true)
    }
  })

  it('never removes the live install even when it is the oldest dir', () => {
    utimesSync(join(persistent, 'sleepypod-releases', 'live'), 1, 1)
    expect(names(plan())).not.toContain('sleepypod-releases/live')
  })

  it('prints an empty plan when /persistent is missing', () => {
    persistent = join(root, 'nope')
    const res = run(['--dry-run', '--json'])
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout).items).toEqual([])
  })

  it('rejects unknown options', () => {
    expect(run(['--bogus']).status).toBe(2)
  })
})
