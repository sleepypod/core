// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The internet access toggle runs iptables as the sleepypod user (CAP_NET_ADMIN,
// no module loading). Pod 4 boots without the iptables modules, so the unit
// must load them as root before the service starts.
const installScript = readFileSync(resolve('scripts/install'), 'utf8')
const updateScript = readFileSync(resolve('scripts/bin/sp-update'), 'utf8')

const MODULES_LINE = /^ExecStartPre=\+\/bin\/sh -c '[^']*modprobe -a ip_tables iptable_filter iptable_nat[^']*; true'$/m

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-iptables-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function dropInBlock(): string {
  const match = updateScript.match(/IPTABLES_MODULES_DROPIN=[\s\S]*?\nfi\n/)
  if (!match) throw new Error('Could not find the iptables modules drop-in in sp-update')
  return match[0]
}

describe('iptables kernel modules', () => {
  it('fresh installs and OTA updates load the same modules as root, best-effort', () => {
    const fromInstall = installScript.match(MODULES_LINE)?.[0]
    const fromUpdate = updateScript.match(MODULES_LINE)?.[0]
    expect(fromInstall).toBeDefined()
    expect(fromUpdate).toBe(fromInstall)
    // The unit's Environment PATH has no sbin; modprobe lives there.
    expect(fromInstall).toContain('PATH=/usr/sbin:/sbin:')
    expect(fromInstall).not.toContain('$')
  })

  it('sp-update writes the drop-in once and reloads systemd only when it changes', () => {
    const dropIn = join(root, 'sleepypod.service.d', 'iptables-modules.conf')
    const reloads = join(root, 'reloads')
    writeFileSync(reloads, '')
    const block = dropInBlock().replace(
      /^IPTABLES_MODULES_DROPIN=.*$/m,
      `IPTABLES_MODULES_DROPIN=${dropIn}`,
    )
    const script = `systemctl() { echo "$*" >> ${reloads}; }\n${block}${block}`
    const result = spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', script], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(dropIn, 'utf8')).toMatch(/^\[Service\]\nExecStartPre=\+.*modprobe -a ip_tables/)
    expect(readFileSync(reloads, 'utf8')).toBe('daemon-reload\n')
  })

  it('never fails the service start when modprobe is missing', () => {
    const line = installScript.match(MODULES_LINE)?.[0] ?? ''
    const command = (line.match(/-c '(.*)'$/)?.[1] ?? 'false')
      .replace('PATH=/usr/sbin:/sbin:/usr/bin:/bin', `PATH=${root}`)
    expect(command).toContain(`PATH=${root} modprobe`)
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    expect(result.status).toBe(0)
  })
})
