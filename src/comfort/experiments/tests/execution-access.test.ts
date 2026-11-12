import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { personalRuntimeFixture } from '@/src/household/tests/runtimeFixture'
import { ExperimentExecutionIdentity } from '../execution-access'

const fixtures: ReturnType<typeof personalRuntimeFixture>[] = []
function fixture() {
  const test = personalRuntimeFixture()
  fixtures.push(test)
  const revision = { current: 'a'.repeat(64) as string | null }
  const identity = new ExperimentExecutionIdentity(test.database, test.identities, test.runtime.authority, () => revision.current)
  return { ...test, identity, revision }
}
afterEach(() => fixtures.splice(0).forEach(test => test.database.close()))

it('derives personal overnight references without saving bearer keys and follows the actual assigned zones', () => {
  const test = fixture(), reference = test.identity.personalPrincipal(test.ownerKey)
  expect(reference).toEqual({ kind: 'personal', deviceId: test.identities.deviceIdentity(test.ownerKey) })
  expect(JSON.stringify(reference)).not.toContain(test.ownerKey)
  expect(test.identity.resolve(reference).zones).toEqual(['left', 'right'])
  const member = test.identity.personalPrincipal(test.memberKey)
  expect(test.identity.subject(member)).toMatch(/^[a-f0-9]{64}$/)
  expect(() => test.identity.resolve(member)).toThrow('assignment')
  test.assignedFixture()
  expect(test.identity.resolve(reference).zones).toEqual(['right'])
  expect(test.identity.resolve(test.identity.personalPrincipal(test.memberKey)).zones).toEqual(['left'])
})

it.each(['device', 'account', 'runtime', 'physical'] as const)('withdraws the original reference after %s changes', (change) => {
  const test = fixture(), reference = test.identity.personalPrincipal(test.ownerKey)
  if (change === 'device') test.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(test.clock.now, test.owner.accountId)
  if (change === 'account') test.database.prepare('UPDATE household_accounts SET state = ? WHERE id = ?').run('removed', test.owner.accountId)
  if (change === 'runtime') test.clock.enabled = false
  if (change === 'physical') test.database.prepare('UPDATE device_settings SET bed_mode = ?').run('two')
  expect(() => test.identity.resolve(reference)).toThrow()
  if (change === 'device' || change === 'account') expect(() => test.identity.subject(reference)).toThrow()
  else expect(test.identity.subject(reference)).toMatch(/^[a-f0-9]{64}$/)
})

it('binds legacy grants to the actual installation, owner credential revision and persistent privacy boundary', () => {
  const test = fixture(), reference = test.identity.legacyPrincipal()
  expect(test.identity.resolve(reference).zones).toEqual(['left', 'right'])
  if (reference.kind !== 'legacy') throw new Error('Expected legacy reference')
  expect(() => test.identity.resolve({ ...reference, installationId: randomUUID() })).toThrow('arrangement')
  test.revision.current = 'b'.repeat(64)
  expect(() => test.identity.resolve(reference)).toThrow('authorization')
  test.revision.current = reference.credentialRevision
  test.database.prepare('INSERT INTO household_privacy_boundary (id, required_at, reason) VALUES (1, ?, ?)')
    .run(test.clock.now, 'synthetic test only')
  expect(() => test.identity.resolve(reference)).toThrow('authorization')
})
