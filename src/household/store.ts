import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { z } from 'zod'
import type { householdContextSchema } from './contract'
import { deviceSecretSchema, householdInvitationSchema, householdJoinSchema, householdSessionSchema, householdSetupSchema, personalWeekSchema, personPreferencesSchema, revokeDeviceSchema, updatePreferencesSchema, updateRoutinesSchema, revokeInvitationSchema, type HouseholdSession } from './contract'
import { validateBedtimeWeek } from '@/src/lib/bedtimeRoutines'
type ErrorCode = 'authentication_required' | 'setup_required' | 'forbidden' | 'conflict' | 'invalid_request' | 'invitation_unavailable' | 'not_ready' | 'rate_limited'
export class HouseholdError extends Error {
  constructor(readonly code: ErrorCode, readonly status: number, message: string) { super(message) }
}
interface HouseholdRow {
  id: string
  pod_id: string
  setup_request_id: string
  revision: number
  assignment_revision: number
  mode: 'solo-anywhere' | 'assigned'
  source_side: 'left' | 'right'
  effective_at: number
}
interface AccountRow {
  id: string
  household_id: string
  sleeper_id: string
  display_name: string
  role: 'owner' | 'member'
  state: string
  assigned_side: 'left' | 'right' | null
  session_revision: number
}
interface DeviceRow {
  id: string
  account_id: string
  token_hash: string
  name: string
  created_at: number
  revoked_at: number | null
}
interface InvitationRow {
  id: string
  household_id: string
  issuer_id: string
  kind: 'new_person' | 'own_device'
  token_hash: string
  request_hash: string
  target_account_id: string | null
  claimed_device_id: string | null
  expires_at: number
  revoked_at: number | null
}
interface SettingsRow {
  preferences: string
  preferences_revision: number
  routines: string
  routines_revision: number
}
export type HouseholdCredential = string | {
  deviceId: string
}
interface Principal {
  account: AccountRow
  device: DeviceRow
  household: HouseholdRow
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const requestDigest = (value: unknown) => digest(JSON.stringify(value))
const defaults = { displayUnit: 'F', preferredTemperatureF: 76, comfort: 'balanced', shareWakeTime: false, cloudAnalysisConsent: false } as const
/** Identity storage never calls the hardware or silently activates routine drafts. */
export class HouseholdStore {
  constructor(private database: Database.Database, private now = () => Date.now()) { }
  /** Identity creation and browser admission commit together or both roll back. */
  withBrowserTransaction<T>(operation: (database: Database.Database) => T): T {
    return this.database.transaction(() => operation(this.database)).immediate()
  }

  private household() {
    return this.database.prepare('SELECT * FROM households LIMIT 1').get() as HouseholdRow | undefined
  }

  private account(id: string) {
    return this.database.prepare('SELECT * FROM household_accounts WHERE id = ?').get(id) as AccountRow | undefined
  }

  private settings(accountId: string) {
    return this.database.prepare('SELECT * FROM household_personal_settings WHERE account_id = ?').get(accountId) as SettingsRow
  }

  private createAccount(householdId: string, name: string, role: 'owner' | 'member') {
    const id = randomUUID()
    this.database.prepare('INSERT INTO household_accounts (id, household_id, sleeper_id, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, householdId, randomUUID(), name, role, this.now())
    this.database.prepare('INSERT INTO household_personal_settings (account_id, preferences, routines) VALUES (?, ?, ?)')
      .run(id, JSON.stringify(defaults), '[]')
    return id
  }

  private createDevice(accountId: string, name: string, secret: string) {
    if (this.database.prepare('SELECT id FROM household_devices WHERE token_hash = ?').get(digest(secret))) {
      throw new HouseholdError('conflict', 409, 'Generate a fresh personal device key.')
    }
    const count = this.database.prepare('SELECT COUNT(*) AS count FROM household_devices WHERE account_id = ? AND revoked_at IS NULL').get(accountId) as {
      count: number
    }
    if (count.count >= 12)
      throw new HouseholdError('conflict', 409, 'Remove an unused personal device before adding another.')
    const id = randomUUID()
    this.database.prepare('INSERT INTO household_devices (id, account_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, accountId, digest(secret), name, this.now())
    return id
  }

  private authenticate(secret: HouseholdCredential): Principal {
    if (typeof secret === 'string' && !deviceSecretSchema.safeParse(secret).success)
      throw new HouseholdError('authentication_required', 401, 'Use your personal connection key.')
    const device = (typeof secret === 'string'
      ? this.database.prepare('SELECT * FROM household_devices WHERE token_hash = ? AND revoked_at IS NULL').get(digest(secret))
      : this.database.prepare('SELECT * FROM household_devices WHERE id = ? AND revoked_at IS NULL').get(secret.deviceId)) as DeviceRow | undefined
    const account = device && this.account(device.account_id)
    const household = this.household()
    if (!device || !account || account.state !== 'active' || !household || account.household_id !== household.id) {
      throw new HouseholdError('authentication_required', 401, 'This personal connection is unavailable or was revoked.')
    }
    return { device, account, household }
  }

  private sessionFor({ account, household }: Principal): HouseholdSession {
    // Assignment activation will be a separate, reviewed transaction. A member's
    // invitation is never interpreted as consent to move the existing sleeper.
    const soloOwner = household.mode === 'solo-anywhere' && account.role === 'owner'
    const assignedSide = household.mode === 'assigned' ? account.assigned_side : null
    return householdSessionSchema.parse({
      apiVersion: 1, featureVersion: 1, podId: household.pod_id, householdId: household.id,
      accountId: account.id, selfSleeperId: account.sleeper_id, role: account.role, membership: 'active',
      sessionRevision: account.session_revision, householdRevision: household.revision, assignmentRevision: household.assignment_revision,
      arrangement: { mode: household.mode, effectiveAt: new Date(household.effective_at).toISOString() },
      self: { displayName: account.display_name, zones: soloOwner ? ['left', 'right'] : assignedSide ? [assignedSide] : [], assignment: soloOwner ? 'solo' : assignedSide ?? 'unassigned' },
      capabilities: { manageInvitations: account.role === 'owner', manageOwnDevices: true,
        personalPreferences: true, personalRoutineDrafts: true, activateArrangement: false,
        personalControls: false, personalHistory: false, healthImport: false, cloudAnalysis: false },
    })
  }

  deviceIdentity(secret: string) { return this.authenticate(secret).device.id }
  session(secret: HouseholdCredential) { return this.sessionFor(this.authenticate(secret)) }
  /** Only the owner-authenticated route calls setup. A lost response is recoverable with the client-held key. */
  setup(input: unknown) {
    const parsed = householdSetupSchema.parse(input)
    return this.database.transaction(() => {
      const existing = this.household()
      if (existing) {
        if (existing.setup_request_id !== parsed.requestId)
          throw new HouseholdError('conflict', 409, 'This Pod already has a household. Use a personal device invitation.')
        const principal = this.authenticate(parsed.deviceSecret)
        if (principal.account.role !== 'owner' || principal.account.display_name !== parsed.displayName || principal.device.name !== parsed.deviceName || existing.source_side !== parsed.sourceSide) {
          throw new HouseholdError('conflict', 409, 'The setup request changed. Reconnect with the original personal device key.')
        }
        return this.sessionFor(principal)
      }
      const id = randomUUID()
      this.database.prepare('INSERT INTO households (id, pod_id, setup_request_id, mode, source_side, effective_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, randomUUID(), parsed.requestId, 'solo-anywhere', parsed.sourceSide, this.now())
      const accountId = this.createAccount(id, parsed.displayName, 'owner')
      this.createDevice(accountId, parsed.deviceName, parsed.deviceSecret)
      return this.session(parsed.deviceSecret)
    }).immediate()
  }

  private assertContext(principal: Principal, context: z.infer<typeof householdContextSchema>) {
    if (principal.account.session_revision !== context.expectedSessionRevision || principal.household.assignment_revision !== context.expectedAssignmentRevision) {
      throw new HouseholdError('conflict', 409, 'Your account or bed assignment changed. Reload before saving.')
    }
  }

  createInvitation(secret: HouseholdCredential, input: unknown) {
    const parsed = householdInvitationSchema.parse(input)
    return this.database.transaction(() => {
      const principal = this.authenticate(secret)
      this.assertContext(principal, parsed)
      if (parsed.kind === 'new_person' && principal.account.role !== 'owner')
        throw new HouseholdError('forbidden', 403, 'Only the household owner may invite another person.')
      const requestHash = requestDigest(parsed)
      const existing = this.database.prepare('SELECT * FROM household_invitations WHERE id = ?').get(parsed.requestId) as InvitationRow | undefined
      if (existing && (existing.issuer_id !== principal.account.id || existing.request_hash !== requestHash)) {
        throw new HouseholdError('conflict', 409, 'This request identifier was already used for a different invitation.')
      }
      if (existing) {
        if (existing.revoked_at !== null || existing.claimed_device_id !== null || existing.expires_at <= this.now())
          throw new HouseholdError('invitation_unavailable', 410, 'This invitation is no longer available.')
        return { id: existing.id, invitation: parsed.invitation, kind: existing.kind, expiresAt: new Date(existing.expires_at).toISOString() }
      }
      const pending = this.database.prepare('SELECT COUNT(*) AS count FROM household_invitations WHERE issuer_id = ? AND claimed_device_id IS NULL AND revoked_at IS NULL AND expires_at > ?').get(principal.account.id, this.now()) as {
        count: number
      }
      if (pending.count >= 8)
        throw new HouseholdError('rate_limited', 429, 'Too many pending invitations. Revoke an old invitation first.')
      if (this.database.prepare('SELECT id FROM household_invitations WHERE token_hash = ?').get(digest(parsed.invitation)))
        throw new HouseholdError('conflict', 409, 'Generate a fresh invitation.')
      const expiresAt = this.now() + parsed.expiresInMinutes * 60000
      this.database.prepare('INSERT INTO household_invitations (id, household_id, issuer_id, kind, token_hash, request_hash, target_account_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(parsed.requestId, principal.household.id, principal.account.id, parsed.kind, digest(parsed.invitation), requestHash, parsed.kind === 'own_device' ? principal.account.id : null, expiresAt)
      return { id: parsed.requestId, invitation: parsed.invitation, kind: parsed.kind, expiresAt: new Date(expiresAt).toISOString() }
    }).immediate()
  }

  join(input: unknown) {
    const parsed = householdJoinSchema.parse(input)
    return this.database.transaction(() => {
      const invitation = this.database.prepare('SELECT * FROM household_invitations WHERE token_hash = ?').get(digest(parsed.invitation)) as InvitationRow | undefined
      const issuer = invitation && this.account(invitation.issuer_id)
      if (!invitation || invitation.revoked_at !== null || !issuer || issuer.state !== 'active')
        throw new HouseholdError('invitation_unavailable', 410, 'Ask for a new personal invitation.')
      if (invitation.claimed_device_id) {
        // Lost response retries succeed only with the exact already-claimed device.
        const principal = this.authenticate(parsed.deviceSecret)
        if (principal.device.id !== invitation.claimed_device_id || principal.device.name !== parsed.deviceName)
          throw new HouseholdError('invitation_unavailable', 410, 'This invitation was already used.')
        return this.sessionFor(principal)
      }
      if (invitation.expires_at <= this.now())
        throw new HouseholdError('invitation_unavailable', 410, 'This invitation expired. Ask for a new one.')
      let accountId = invitation.target_account_id
      if (invitation.kind === 'new_person') {
        const count = this.database.prepare('SELECT COUNT(*) AS count FROM household_accounts WHERE household_id = ? AND state = ?').get(invitation.household_id, 'active') as {
          count: number
        }
        if (count.count >= 2)
          throw new HouseholdError('conflict', 409, 'This bed already has two personal accounts.')
        accountId = this.createAccount(invitation.household_id, parsed.displayName, 'member')
      }
      if (!accountId || this.account(accountId)?.state !== 'active')
        throw new HouseholdError('invitation_unavailable', 410, 'This personal account is unavailable.')
      const deviceId = this.createDevice(accountId, parsed.deviceName, parsed.deviceSecret)
      this.database.prepare('UPDATE household_invitations SET claimed_device_id = ? WHERE id = ?').run(deviceId, invitation.id)
      this.database.prepare('UPDATE households SET revision = revision + 1 WHERE id = ?').run(invitation.household_id)
      return this.session(parsed.deviceSecret)
    }).immediate()
  }

  invitations(secret: HouseholdCredential) {
    const principal = this.authenticate(secret)
    return { invitations: this.database.prepare('SELECT id, kind, expires_at AS expiresAt, claimed_device_id AS claimedDeviceId, revoked_at AS revokedAt FROM household_invitations WHERE issuer_id = ? ORDER BY expires_at DESC LIMIT 100').all(principal.account.id)
      .map((entry) => {
        const row = entry as {
          id: string
          kind: string
          expiresAt: number
          claimedDeviceId: string | null
          revokedAt: number | null
        }
        return { id: row.id, kind: row.kind, expiresAt: new Date(row.expiresAt).toISOString(), status: row.revokedAt !== null ? 'revoked' : row.claimedDeviceId ? 'claimed' : row.expiresAt <= this.now() ? 'expired' : 'pending' }
      }) }
  }

  private mutate<Result>(secret: HouseholdCredential, kind: string, input: z.infer<typeof householdContextSchema>, operation: (principal: Principal) => Result): Result {
    return this.database.transaction(() => {
      const principal = this.authenticate(secret)
      this.assertContext(principal, input)
      const requestHash = requestDigest(input)
      const previous = this.database.prepare('SELECT * FROM household_mutation_receipts WHERE request_id = ?').get(input.requestId) as {
        account_id: string
        kind: string
        request_hash: string
        result: string
      } | undefined
      if (previous) {
        if (previous.account_id !== principal.account.id || previous.kind !== kind || previous.request_hash !== requestHash)
          throw new HouseholdError('conflict', 409, 'This request identifier was already used.')
        return JSON.parse(previous.result) as Result
      }
      const result = operation(principal)
      this.database.prepare('INSERT INTO household_mutation_receipts (request_id, account_id, kind, request_hash, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.requestId, principal.account.id, kind, requestHash, JSON.stringify(result), this.now())
      return result
    }).immediate()
  }

  revokeInvitation(secret: HouseholdCredential, input: unknown) {
    const parsed = revokeInvitationSchema.parse(input)
    return this.mutate(secret, 'revoke_invitation', parsed, (principal) => {
      const result = this.database.prepare('UPDATE household_invitations SET revoked_at = ? WHERE id = ? AND issuer_id = ? AND claimed_device_id IS NULL').run(this.now(), parsed.invitationId, principal.account.id)
      if (result.changes !== 1)
        throw new HouseholdError('forbidden', 403, 'That pending invitation is unavailable to your account.')
      return { revoked: true }
    })
  }

  preferences(secret: HouseholdCredential) {
    const principal = this.authenticate(secret), settings = this.settings(principal.account.id)
    return { sleeperId: principal.account.sleeper_id, revision: settings.preferences_revision, preferences: personPreferencesSchema.parse(JSON.parse(settings.preferences)) }
  }

  updatePreferences(secret: HouseholdCredential, input: unknown) {
    const parsed = updatePreferencesSchema.parse(input)
    return this.mutate(secret, 'preferences', parsed, (principal) => {
      const result = this.database.prepare('UPDATE household_personal_settings SET preferences = ?, preferences_revision = preferences_revision + 1 WHERE account_id = ? AND preferences_revision = ?')
        .run(JSON.stringify(parsed.preferences), principal.account.id, parsed.expectedRevision)
      if (result.changes !== 1)
        throw new HouseholdError('conflict', 409, 'Your preferences changed on another device. Reload first.')
      return this.preferences(secret)
    })
  }

  routines(secret: HouseholdCredential) {
    const principal = this.authenticate(secret), settings = this.settings(principal.account.id)
    return { sleeperId: principal.account.sleeper_id, revision: settings.routines_revision, status: 'draft_only' as const, routines: personalWeekSchema.parse(JSON.parse(settings.routines)) }
  }

  updateRoutines(secret: HouseholdCredential, input: unknown) {
    const parsed = updateRoutinesSchema.parse(input)
    try {
      validateBedtimeWeek('left', parsed.routines)
    }
    catch {
      throw new HouseholdError('invalid_request', 400, 'Routine drafts overlap or contain an invalid night.')
    }
    return this.mutate(secret, 'routines', parsed, (principal) => {
      const result = this.database.prepare('UPDATE household_personal_settings SET routines = ?, routines_revision = routines_revision + 1 WHERE account_id = ? AND routines_revision = ?')
        .run(JSON.stringify(parsed.routines), principal.account.id, parsed.expectedRevision)
      if (result.changes !== 1)
        throw new HouseholdError('conflict', 409, 'Your routine drafts changed on another device. Reload first.')
      return this.routines(secret)
    })
  }

  devices(secret: HouseholdCredential) {
    const principal = this.authenticate(secret)
    const devices = this.database.prepare('SELECT * FROM household_devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at, id').all(principal.account.id) as DeviceRow[]
    return { devices: devices.map(device => ({ id: device.id, name: device.name, createdAt: new Date(device.created_at).toISOString(), current: device.id === principal.device.id })) }
  }

  revokeDevice(secret: HouseholdCredential, input: unknown) {
    const parsed = revokeDeviceSchema.parse(input)
    return this.mutate(secret, 'revoke_device', parsed, (principal) => {
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM household_devices WHERE account_id = ? AND revoked_at IS NULL').get(principal.account.id) as {
        count: number
      }
      if (count.count <= 1)
        throw new HouseholdError('conflict', 409, 'Add a replacement device before removing your last personal connection.')
      const result = this.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL').run(this.now(), parsed.deviceId, principal.account.id)
      if (result.changes !== 1)
        throw new HouseholdError('forbidden', 403, 'That device is unavailable to your account.')
      // Browser sessions resolve their device on every request, so revocation is immediate.
      return { revoked: true }
    })
  }
}
