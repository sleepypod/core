import { describe, it, expect, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import controls from '../../fixtures/personal-controls-v1.json'
import routines from '../../fixtures/personal-routines-v1.json'
import { householdSessionSchema } from '../../contract'
import { personalControlRequestSchema } from '../../controlContract'
import { personalRoutineReviewSchema, personalRoutinePublishSchema } from '../../routineContract'
import { PersonalWebWorkspace } from '../workspace'
import { PersonalWebError, controlReference, publicationReference, readOwnReceipt, readPersonalBed, readRoutineReview, type RecoveryReference } from '../protocol'
import type { RecoveryJournal } from '../recovery'
import type { PersonalWebTransport } from '../client'

const session = () => householdSessionSchema.parse({ ...preparation.ownerSession, selfSleeperId: controls.soloBed.scope.sleeperId,
  capabilities: { ...preparation.ownerSession.capabilities, personalControls: true, personalRoutinePublication: true } })
const action = { kind: 'temperature' as const, temperatureF: 70, holdMinutes: 30 }
function setup() {
  let now = controls.soloBed.observation.observedAt, uptime = 0
  const current = session()
  const bed = structuredClone(controls.soloBed)
  const review = personalRoutineReviewSchema.parse(routines.readyReview)
  const records: RecoveryReference[] = []
  const events: string[] = []
  const journal: RecoveryJournal = {
    list: vi.fn(async () => [...records]),
    reserve: vi.fn(async (reference, additional) => {
      if (!additional && records.some(value => value.kind === reference.kind)) throw new PersonalWebError('pending', 'Previous result unresolved')
      events.push('reserve')
      records.push(reference)
    }),
    remove: vi.fn(async (reference) => {
      records.splice(records.indexOf(reference), 1)
    }),
  }
  const receipts = new Map<string, unknown>()
  const drafts = { ...preparation.routines, sleeperId: current.selfSleeperId, revision: 2, routines: review.draftWeek }
  const client: PersonalWebTransport = {
    dispose: vi.fn(),
    read: vi.fn(async (path, method = 'GET', input) => {
      if (path === 'household/session') return current
      if (path === 'me/bed') return bed
      if (path === 'me/routines/review') return review
      if (path === 'me/routines' && method === 'GET') return drafts
      if (path === 'me/routines' && method === 'PUT') {
        events.push('draft')
        return { ...drafts, revision: 3, routines: (input as { routines: unknown }).routines }
      }
      if (path === 'me/controls' && method === 'POST') {
        events.push('post')
        const request = personalControlRequestSchema.parse(input)
        const receipt = { ...controls.acknowledged, ...request, receivedAt: now, finishedAt: now + 2, lastDispatchAt: now + 1 }
        receipts.set(request.requestId, receipt)
        return receipt
      }
      if (path === 'me/routines/publish' && method === 'POST') {
        events.push('publish')
        const request = personalRoutinePublishSchema.parse(input)
        const receipt = { ...routines.saved, requestId: request.requestId }
        receipts.set(request.requestId, receipt)
        return receipt
      }
      if (receipts.has(path.split('/').at(-1) ?? '')) return receipts.get(path.split('/').at(-1) ?? '')
      throw new PersonalWebError('missing', 'No receipt yet')
    }),
  }
  const invalidated = vi.fn()
  const workspace = new PersonalWebWorkspace({ session: structuredClone(current), client, journal, invalidated, now: () => now, uptime: () => uptime })
  return { workspace, client, journal, records, current, bed, review, receipts, events, invalidated,
    setNow: (value: number) => now = value, setUptime: (value: number) => uptime = value }
}

describe('isolated personal browser commands', () => {
  it('persists recovery before the only POST, then clears a matching acknowledgment', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    await fixture.workspace.control(action)
    expect(fixture.events).toEqual(['reserve', 'post'])
    expect(fixture.records).toEqual([])
    expect(fixture.workspace.getSnapshot().message).toContain('acknowledged')
  })
  it('does not send a command when durable recovery fails', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    vi.mocked(fixture.journal.reserve).mockRejectedValue(new Error('storage denied'))
    await fixture.workspace.control(action)
    expect(fixture.events).toEqual([])
  })
  it('keeps a lost reply, permits Stop, and reconciles with GET without replay', async () => {
    const fixture = setup()
    const original = fixture.client.read
    fixture.client.read = vi.fn(async (path, method, input) => {
      const result = await original(path, method, input)
      if (path === 'me/controls' && (input as { action?: typeof action })?.action?.kind === 'temperature') throw new Error('reply lost')
      return result
    })
    await fixture.workspace.start()
    await fixture.workspace.control(action)
    expect(fixture.records).toHaveLength(1)
    expect(fixture.workspace.canControl()).toBe(false)
    expect(fixture.workspace.canControl(true)).toBe(true)
    await fixture.workspace.control(action)
    await fixture.workspace.control({ kind: 'power', powered: false })
    expect(fixture.events.filter(value => value === 'post')).toHaveLength(2)
    const reference = fixture.records[0]
    await fixture.workspace.reconcile(reference)
    expect(fixture.records).toHaveLength(0)
    expect(fixture.events.filter(value => value === 'post')).toHaveLength(2)
  })
  it('preserves uncertainty after a post-commit authentication error and hides the view', async () => {
    const fixture = setup()
    const original = fixture.client.read
    fixture.client.read = vi.fn(async (path, method, input) => {
      const result = await original(path, method, input)
      if (path === 'me/controls') throw new PersonalWebError('authentication', 'Reconnect')
      return result
    })
    await fixture.workspace.start()
    await fixture.workspace.control(action)
    expect(fixture.records).toHaveLength(1)
    expect(fixture.invalidated).toHaveBeenCalledOnce()
    expect(fixture.workspace.getSnapshot().bed).toBeNull()
  })
  it.each(['assignmentRevision', 'sessionRevision'] as const)('rejects changed %s before sending', async (field) => {
    const fixture = setup()
    await fixture.workspace.start()
    fixture.current[field]++
    await fixture.workspace.control(action)
    expect(fixture.events).toEqual([])
    expect(fixture.invalidated).toHaveBeenCalledOnce()
  })
  it('requires explicit review of changed configuration, then uses its new scope', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    fixture.bed.scope.configurationRevision = 'e'.repeat(64)
    await fixture.workspace.refresh()
    expect(fixture.workspace.canControl()).toBe(false)
    fixture.workspace.reviewScope()
    await fixture.workspace.control(action)
    expect(fixture.events).toContain('post')
  })
  it('Stop cancels an ordinary request still waiting on preflight', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    let release!: (value: unknown) => void
    vi.mocked(fixture.client.read).mockImplementationOnce(() => new Promise(resolve => release = resolve))
    const pending = fixture.workspace.control(action)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await fixture.workspace.control({ kind: 'power', powered: false })
    release(fixture.current)
    await pending
    expect(fixture.events.filter(value => value === 'post')).toHaveLength(1)
    expect(fixture.records).toHaveLength(0)
    expect(fixture.workspace.getSnapshot().error).toContain('canceled by Stop')
  })
  it('explicit draft reload changes editor generation even if revision did not change', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    const before = fixture.workspace.getSnapshot().draftLoad
    await fixture.workspace.refresh(true)
    expect(fixture.workspace.getSnapshot().draftLoad).toBe(before + 1)
  })
  it('expires stale observations with monotonic time even if wall time rolls back', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    fixture.setUptime(16000)
    fixture.setNow(controls.soloBed.observation.observedAt - 3000)
    fixture.workspace.tick()
    expect(fixture.workspace.getSnapshot().fresh).toBe(false)
    expect(fixture.workspace.canControl()).toBe(false)
    expect(fixture.workspace.canControl(true)).toBe(true)
    fixture.setUptime(0)
    fixture.setNow(controls.soloBed.observation.observedAt)
    fixture.workspace.tick()
    expect(fixture.workspace.getSnapshot().fresh).toBe(false)
  })
  it.each([{ water: 'low' }, { priming: true }, { priming: null }])('blocks normal changes for %j but permits Stop', async (observation) => {
    const fixture = setup()
    Object.assign(fixture.bed.observation, observation)
    await fixture.workspace.start()
    expect(fixture.workspace.canControl()).toBe(false)
    expect(fixture.workspace.canControl(true)).toBe(true)
  })
  it('rechecks water status in preflight before persisting or sending', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    fixture.bed.observation.water = 'low'
    await fixture.workspace.control(action)
    expect(fixture.events).toEqual([])
    expect(fixture.workspace.getSnapshot().error).toContain('water and priming status')
  })
  it.each(['empty', 'failure'])('does not let an older %s recovery scan hide a newly reserved unknown request', async (outcome) => {
    const fixture = setup()
    await fixture.workspace.start()
    let release!: (value: RecoveryReference[]) => void
    let reject!: (reason: Error) => void
    vi.mocked(fixture.journal.list).mockImplementationOnce(() => new Promise((resolve, failure) => {
      release = resolve
      reject = failure
    }))
    const refreshing = fixture.workspace.refresh()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const original = fixture.client.read
    fixture.client.read = vi.fn(async (path, method, input) => {
      const result = await original(path, method, input)
      if (method === 'POST') throw new Error('reply lost')
      return result
    })
    await fixture.workspace.control(action)
    if (outcome === 'empty') release([])
    else reject(new Error('older read failed'))
    await refreshing
    expect(fixture.workspace.getSnapshot().storageReady).toBe(true)
    expect(fixture.workspace.getSnapshot().references).toHaveLength(1)
    expect(fixture.workspace.canControl()).toBe(false)
  })
  it('does not let a delayed pre-command refresh overwrite the new bed', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    const old = structuredClone(fixture.bed)
    let release!: (value: unknown) => void
    vi.mocked(fixture.client.read).mockImplementationOnce(async () => fixture.current).mockImplementationOnce(() => new Promise(resolve => release = resolve))
    const refreshing = fixture.workspace.refresh()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    fixture.bed.zones[0].measuredTemperatureF = 73
    await fixture.workspace.control(action)
    release(old)
    await refreshing
    expect(fixture.workspace.getSnapshot().bed?.zones[0].measuredTemperatureF).toBe(73)
  })
})

describe('private routine publication', () => {
  it('saves a private draft without publishing, preserving custom alarm fields', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    const week = structuredClone(fixture.review.draftWeek)
    if (week[0].draft.alarm) week[0].draft.alarm.snoozeDuration = 541
    await fixture.workspace.saveDraft(week)
    expect(fixture.events).toEqual(['draft'])
    expect(fixture.workspace.getSnapshot().drafts?.routines[0].draft.alarm?.snoozeDuration).toBe(541)
  })
  it('does not let a delayed draft reload replace a newer successful save', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    let release!: (value: unknown) => void
    const old = structuredClone(fixture.workspace.getSnapshot().drafts)
    const original = fixture.client.read
    let hold = true
    fixture.client.read = vi.fn(async (path, method, input) => {
      if (path === 'me/routines' && !method && hold) {
        hold = false
        return new Promise(resolve => release = resolve)
      }
      return original(path, method, input)
    })
    const refreshing = fixture.workspace.refresh(true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const week = structuredClone(fixture.review.draftWeek)
    week[0].draft.power.onTemperature = 68
    expect(await fixture.workspace.saveDraft(week)).toBe(true)
    release(old)
    await refreshing
    expect(fixture.workspace.getSnapshot().drafts?.revision).toBe(3)
    expect(fixture.workspace.getSnapshot().drafts?.routines[0].draft.power.onTemperature).toBe(68)
  })
  it('requires both acknowledgments and rechecks the review before publishing', async () => {
    const fixture = setup()
    await fixture.workspace.start()
    await fixture.workspace.publish(fixture.review, { replaceWeek: true, currentEffect: false })
    expect(fixture.events).toEqual([])
    await fixture.workspace.publish(fixture.review, { replaceWeek: true, currentEffect: true })
    expect(fixture.events).toEqual(['reserve', 'publish'])
    expect(fixture.records).toHaveLength(0)
    expect(fixture.workspace.getSnapshot().message).toContain('registered')
  })
  it('does not publish after the reviewed week changes', async () => {
    const fixture = setup()
    const reviewed = structuredClone(fixture.review)
    await fixture.workspace.start()
    fixture.review.reviewRevision = 'b'.repeat(64)
    await fixture.workspace.publish(reviewed, { replaceWeek: true, currentEffect: true })
    expect(fixture.events).toEqual([])
  })
  it('keeps saved-but-unconfirmed schedules recoverable instead of publishing twice', async () => {
    const fixture = setup()
    const original = fixture.client.read
    fixture.client.read = vi.fn(async (path, method, input) => {
      const result = await original(path, method, input)
      return path === 'me/routines/publish' ? { ...(result as object), scheduler: 'unconfirmed' } : result
    })
    await fixture.workspace.start()
    await fixture.workspace.publish(fixture.review, { replaceWeek: true, currentEffect: true })
    await fixture.workspace.publish(fixture.review, { replaceWeek: true, currentEffect: true })
    expect(fixture.events).toEqual(['reserve', 'publish'])
    expect(fixture.records).toHaveLength(1)
    await fixture.workspace.reconcile(fixture.records[0])
    expect(fixture.records).toHaveLength(0)
  })
})

describe('browser protocol isolation', () => {
  it('retains different solo-zone readings instead of averaging or selecting one', () => {
    const bed = readPersonalBed(controls.soloBed, session())
    expect(bed.zones.map(zone => zone.reportedTargetF)).toEqual([70, 82])
  })
  it('rejects foreign, duplicate, or inconsistent zone routing', () => {
    const invalid = structuredClone(controls.soloBed)
    invalid.routing.power = ['left']
    expect(() => readPersonalBed(invalid, session())).toThrow()
    expect(() => readPersonalBed(controls.soloBed, { ...session(), self: { ...session().self, zones: ['left'] } })).toThrow()
  })
  it('rejects a copied receipt with changed values or another identity', () => {
    const reference = controlReference(session(), personalControlRequestSchema.parse(controls.temperatureRequest), ['left', 'right'])
    expect(readOwnReceipt(controls.acknowledged, reference, session())).toEqual(controls.acknowledged)
    expect(() => readOwnReceipt({ ...controls.acknowledged, action: { ...action, temperatureF: 90 } }, reference, session())).toThrow()
    expect(() => readOwnReceipt(controls.acknowledged, reference, { ...session(), accountId: '00000000-0000-4000-8000-000000000010' })).toThrow()
    expect(JSON.stringify(reference)).not.toMatch(/temperatureF|token|issuedAt|holdMinutes/)
  })
  it('refuses a review with conflicting routes or a misleading publish flag', () => {
    expect(() => readRoutineReview({ ...routines.readyReview, temperatureZones: ['left'] }, session())).toThrow()
    expect(() => readRoutineReview({ ...routines.readyReview, reason: 'draft_not_prepared' }, session())).toThrow()
    expect(() => readRoutineReview({ ...routines.readyReview, draftWeek: [...routines.readyReview.draftWeek, ...routines.readyReview.draftWeek] }, session())).toThrow()
  })
  it('validates the whole published week, including custom snooze seconds', () => {
    const reference = publicationReference(session(), personalRoutinePublishSchema.parse(routines.publishRequest), personalRoutineReviewSchema.parse(routines.readyReview))
    expect(readOwnReceipt(routines.saved, reference, session()).state).toBe('saved')
    const changed = structuredClone(routines.saved)
    changed.publishedWeek[0].draft.alarm.snoozeDuration = 541
    expect(() => readOwnReceipt(changed, reference, session())).toThrow()
  })
})
