import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginHardwareWrite, blockHardwareUntilRestart, captureHardwareIntent, classifyDacAdmission, HardwareAdmissionError,
  installHardwareAdmission, outsideHardwareIntent, waitForHardwareDrain, withinHardwareIntent } from '../admission'
import { withSideLock } from '../sideLock'
import { outsideControlRequest } from '@/src/controls/context'

let uninstall: (() => void) | undefined
afterEach(() => {
  uninstall?.()
  uninstall = undefined
  vi.useRealTimers()
})
const holdId = '0f937a24-0c7b-41b0-a38e-94a16017db73'
function source() {
  const state: { revision: number, holdId: string | null } = { revision: 1, holdId: null }
  uninstall = installHardwareAdmission({ read: () => ({ ...state }) })
  return state
}

describe('durable hardware admission', () => {
  it('keeps a failed runtime blocked across durable revisions until replacement, preserving Stop', () => {
    const state = source()
    const prior = captureHardwareIntent()
    blockHardwareUntilRestart()
    expect(() => beginHardwareWrite(prior)).toThrow(HardwareAdmissionError)
    expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
    state.revision += 2
    expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
    beginHardwareWrite(prior, true)()
    uninstall?.()
    uninstall = undefined
    source()
    beginHardwareWrite(captureHardwareIntent())()
    expect(() => beginHardwareWrite(prior)).toThrow(HardwareAdmissionError)
  })
  it('fails closed before initialization and preserves explicit Stop', () => {
    expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
    expect(() => beginHardwareWrite(captureHardwareIntent(), true)()).not.toThrow()
    const unknown = captureHardwareIntent()
    source()
    expect(() => beginHardwareWrite(unknown)).toThrow(HardwareAdmissionError)
  })
  it('rejects queued intent after hold and release while admitting only fresh intent', () => {
    const state = source()
    const prior = captureHardwareIntent()
    state.revision++
    state.holdId = holdId
    expect(() => beginHardwareWrite(prior)).toThrow(HardwareAdmissionError)
    const during = captureHardwareIntent()
    state.revision++
    state.holdId = null
    expect(() => beginHardwareWrite(prior)).toThrow(HardwareAdmissionError)
    expect(() => beginHardwareWrite(during)).toThrow(HardwareAdmissionError)
    beginHardwareWrite(captureHardwareIntent())()
  })
  it('keeps a delayed second command on the original revision', async () => {
    const state = source()
    await withinHardwareIntent(async () => {
      beginHardwareWrite(captureHardwareIntent())()
      await Promise.resolve()
      state.revision += 2
      expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
      outsideHardwareIntent(() => beginHardwareWrite(captureHardwareIntent())())
    })
  })
  it('does not revive queued intent when older admission storage is restored within this process', () => {
    const state = source()
    const old = captureHardwareIntent()
    state.revision = 2
    state.holdId = holdId
    captureHardwareIntent()
    state.revision = 1
    state.holdId = null
    expect(() => beginHardwareWrite(old)).toThrow(HardwareAdmissionError)
    expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
    beginHardwareWrite(captureHardwareIntent(), true)()
  })
  it('rejects a hold changed without advancing its durable revision', () => {
    const state = source()
    const old = captureHardwareIntent()
    state.holdId = holdId
    expect(() => beginHardwareWrite(old)).toThrow(HardwareAdmissionError)
    expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
  })
  it('captures before waiting for a side lock and does not poison later requests', async () => {
    const state = source()
    let release!: () => void
    const first = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    const second = withSideLock('left', async () => beginHardwareWrite(captureHardwareIntent())())
    const rejected = expect(second).rejects.toThrow(HardwareAdmissionError)
    state.revision += 2
    release()
    await first
    await rejected
    await withSideLock('left', async () => beginHardwareWrite(captureHardwareIntent())())
  })
  it('does not give long-lived scheduler callbacks their initializing request revision', async () => {
    const state = source()
    let later!: Promise<void>
    await withinHardwareIntent(async () => {
      later = outsideControlRequest(async () => {
        await Promise.resolve()
        state.revision += 2
        beginHardwareWrite(captureHardwareIntent())()
      })
    })
    await later
  })
  it('waits for acknowledged completion of in-flight writes and rechecks the hold', async () => {
    const state = source()
    const finish = beginHardwareWrite(captureHardwareIntent())
    state.revision++
    state.holdId = holdId
    let drained = false
    const draining = waitForHardwareDrain(holdId).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    finish()
    finish()
    await draining
    expect(drained).toBe(true)
  })
  it('a timeout leaves admission closed and a later acknowledgment can drain safely', async () => {
    vi.useFakeTimers()
    const state = source()
    const finish = beginHardwareWrite(captureHardwareIntent())
    state.revision++
    state.holdId = holdId
    const timedOut = expect(waitForHardwareDrain(holdId, 100)).rejects.toThrow('drain deadline')
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
    expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
    finish()
    await waitForHardwareDrain(holdId)
    expect(state.holdId).toBe(holdId)
  })
  it('does not report idle if a Stop starts before the drained waiter resumes', async () => {
    const state = source()
    const finish = beginHardwareWrite(captureHardwareIntent())
    state.revision++
    state.holdId = holdId
    const draining = expect(waitForHardwareDrain(holdId)).rejects.toThrow('Stop command is still completing')
    finish()
    const finishStop = beginHardwareWrite(captureHardwareIntent(), true)
    try {
      await draining
    }
    finally { finishStop() }
    await waitForHardwareDrain(holdId)
  })
  it('refuses a false drain when another hold replaces the receipt', async () => {
    const state = source()
    const finish = beginHardwareWrite(captureHardwareIntent())
    state.revision++
    state.holdId = holdId
    const drained = expect(waitForHardwareDrain(holdId)).rejects.toThrow(HardwareAdmissionError)
    state.holdId = 'another-hold'
    finish()
    await drained
  })
  it('does not detach an active writer or reuse intent after runtime replacement', () => {
    source()
    const intent = captureHardwareIntent()
    const finish = beginHardwareWrite(intent)
    expect(() => uninstall?.()).toThrow('not drained')
    finish()
    uninstall?.()
    uninstall = undefined
    source()
    expect(() => beginHardwareWrite(intent)).toThrow(HardwareAdmissionError)
  })
  it.each([null, { revision: 0, holdId: null }, { revision: 1.5, holdId: null }, { revision: 1, holdId: '' }])('rejects malformed storage %j without blocking Stop', (value) => {
    uninstall = installHardwareAdmission({ read: () => value as never })
    const intent = captureHardwareIntent()
    expect(() => beginHardwareWrite(intent)).toThrow(HardwareAdmissionError)
    beginHardwareWrite(intent, true)()
  })
  it('rejects storage errors even after a valid intent was captured', () => {
    let unavailable = false
    uninstall = installHardwareAdmission({ read: () => {
      if (unavailable) throw new Error('disk unavailable')
      return { revision: 1, holdId: null }
    } })
    const intent = captureHardwareIntent()
    unavailable = true
    expect(() => beginHardwareWrite(intent)).toThrow(HardwareAdmissionError)
    beginHardwareWrite(intent, true)()
  })
  it.each(['0', '14'])('allows exact read %s', message => expect(classifyDacAdmission(message)).toBe('read'))
  it.each(['9\n0', '10\n0', '16\n0', '16\n1'])('allows exact stop %s', message => expect(classifyDacAdmission(message)).toBe('stop'))
  it.each(['11\n0', '12\n0', '9\n00', '10\n0\n13', '16\n2', '14\n13', '0\n\n13', '13', '5\nopaque', '8\nopaque'])('does not exempt unsafe/ambiguous wire data %s', message => expect(classifyDacAdmission(message)).toBe('change'))
})
