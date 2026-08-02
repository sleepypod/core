import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const maintenanceScript = readFileSync(join(repoRoot, 'scripts/bin/sp-maintenance'), 'utf8')
const installScript = readFileSync(join(repoRoot, 'scripts/install'), 'utf8')
const uninstallScript = readFileSync(join(repoRoot, 'scripts/bin/sp-uninstall'), 'utf8')

describe('sp-maintenance deployment contracts', () => {
  it('declares an absolute visudo fallback outside the restricted ExecStartPre PATH', () => {
    const servicePath = installScript.match(/Environment="PATH=([^"]+)"/)?.[1]

    expect(servicePath).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(servicePath?.split(':')).not.toContain('/usr/sbin')
    expect(maintenanceScript).toContain('/usr/sbin/visudo')
    expect(maintenanceScript).toContain('if [ -x "$candidate" ]')
    expect(maintenanceScript).toContain('elif "$VISUDO_BIN" -c -q -f "$TMP_SUDOERS"')
    expect(maintenanceScript).not.toMatch(/^\s*if visudo\b/m)
  })

  it('keeps the OTA and fresh-install reboot grants identical and narrowly scoped', () => {
    const rebootRule
      = 'sleepypod ALL=(root) NOPASSWD: /bin/systemctl reboot, /usr/bin/systemctl reboot'

    expect(maintenanceScript).toContain(`REBOOT_SUDOERS_CONTENT='${rebootRule}'`)
    expect(installScript).toContain(rebootRule)
  })

  it('keeps temporary-fragment failures in guarded conditional branches', () => {
    expect(maintenanceScript).toContain(
      'if ! printf \'%s\\n\' "$REBOOT_SUDOERS_CONTENT" > "$TMP_SUDOERS"; then',
    )
    expect(maintenanceScript).toContain(
      'elif ! chmod 0440 "$TMP_SUDOERS" 2>/dev/null; then',
    )
    expect(maintenanceScript).toContain('rm -f "$TMP_SUDOERS" 2>/dev/null || true')
  })

  it('removes both reboot authorization paths during uninstall', () => {
    expect(uninstallScript).toContain('/etc/sudoers.d/sleepypod-update')
    expect(uninstallScript).toContain('/etc/sudoers.d/sleepypod-reboot')
  })
})
