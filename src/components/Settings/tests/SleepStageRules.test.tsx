/**
 * SleepStageRules — rules as sentences with click-to-edit values, the quick
 * adjust sliders, saving / resetting / reverting payloads, presets,
 * validation, and the debounced preview with its per-rule statistics.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STAGE_CLASSIFIER,
  DEFAULT_STAGE_RULESET,
  MOVEMENT_ONLY_STAGE_RULESET,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'

const trpcMock = vi.hoisted(() => {
  const setMutate = vi.fn()
  const previewMutate = vi.fn()
  const state = {
    classifier: null as unknown as StageClassifier,
    movementOnly: null as unknown as StageClassifier['ruleset'],
    isDefault: true,
    changes: [] as unknown[],
    preview: undefined as unknown,
    savePending: false,
  }
  return {
    setMutate,
    previewMutate,
    state,
    trpc: {
      useUtils: () => ({ sleepStages: { getClassifier: { invalidate: vi.fn() } } }),
      sleepStages: {
        getClassifier: {
          useQuery: () => ({
            data: {
              classifier: state.classifier,
              isDefault: state.isDefault,
              changes: state.changes,
              presets: [
                { id: 'default', label: 'Default', description: '', classifier: { engine: 'rules', ruleset: state.classifier.ruleset } },
                { id: 'movementOnly', label: 'Movement only', description: '', classifier: { engine: 'rules', ruleset: state.movementOnly } },
              ],
            },
            isLoading: false,
            error: null,
          }),
        },
        setClassifier: { useMutation: () => ({ mutate: setMutate, isPending: state.savePending, error: null }) },
        previewClassifier: { useMutation: () => ({ mutate: previewMutate, data: state.preview, error: null, isPending: false }) },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Left', rightName: 'Right', sideName: (s: string) => s }) }))

import { SleepStageRules } from '../SleepStageRules'

const renderRules = () => render(<SleepStageRules side="left" onSideChange={vi.fn()} />)
const savedRuleset = () => trpcMock.setMutate.mock.calls.at(-1)?.[0].classifier.ruleset
const open = (label: string) => fireEvent.click(screen.getByLabelText(label))

const MIN = 60_000
const BED = Date.UTC(2026, 9, 10, 23)

function night(over: { quality: number, accuracy: number, kappa: number | null, wake: number, deep: number }) {
  return {
    blocks: [],
    distribution: { wake: 8, light: 61, deep: 14, rem: 17 },
    qualityScore: over.quality,
    totalSleepMs: 8 * 60 * MIN,
    durations: { wake: over.wake * MIN, light: 300 * MIN, deep: over.deep * MIN, rem: 80 * MIN },
    agreement: { epochs: 90, accuracy: over.accuracy, kappa: over.kappa },
    stats: {
      epochs: 100,
      nights: 1,
      lowSignalNights: 0,
      rules: { epochs: 100, hits: [8, 14, 17, 0, 2], matches: [8, 14, 17, 5, 2], shadowedBy: [null, null, null, 2, null], fallbackHits: 59 },
      lowSignalRules: null,
      metricRanges: {
        hrRatio: { min: 0.86, max: 1.08 },
        heartRate: { min: 48, max: 96 },
        hrv: { min: 9, max: 118 },
        breathingRate: { min: 11, max: 17 },
        movement: { min: 0, max: 412 },
      },
      heartRateReadings: 100,
      spikesDropped: 3,
      smoothed: 6,
      transitionFixes: 4,
    },
  }
}

const PREVIEW = {
  sleepRecordId: 1,
  enteredBedAt: BED,
  leftBedAt: BED + 8 * 60 * MIN,
  nights: 1,
  hasReference: true,
  saved: night({ quality: 88, accuracy: 0.84, kappa: 0.74, wake: 38, deep: 65 }),
  candidate: night({ quality: 89, accuracy: 0.86, kappa: 0.77, wake: 41, deep: 72 }),
  changed: { segments: [{ start: BED + 60 * MIN, end: BED + 90 * MIN }], changed: 6, total: 100 },
}

beforeEach(() => {
  vi.useFakeTimers()
  trpcMock.setMutate.mockClear()
  trpcMock.previewMutate.mockClear()
  Object.assign(trpcMock.state, {
    classifier: DEFAULT_STAGE_CLASSIFIER,
    isDefault: true,
    changes: [],
    preview: undefined,
    movementOnly: MOVEMENT_ONLY_STAGE_RULESET,
    savePending: false,
  })
})

afterEach(() => vi.useRealTimers())

describe('SleepStageRules', () => {
  it('reads the default rules as sentences with save and reset disabled', () => {
    renderRules()
    expect(screen.getByText('Profile: System defaults')).toBeTruthy()
    expect(screen.getByLabelText('Rule 1 condition 1').textContent).toBe('movement >')
    expect(screen.getByLabelText('Rule 1 condition 1 value').textContent).toBe('200')
    expect(screen.getByLabelText('Rule 2 stage').textContent).toBe('Deep')
    expect(screen.getByLabelText('Rule 2 condition 1 value').textContent).toBe('0.92')
    expect(screen.getByLabelText('Rule 3 condition 2 value').textContent).toBe('25 ms')
    expect(screen.getByLabelText('Fallback stage').textContent).toBe('Light')
    expect(screen.getByLabelText('Heart rate (bpm) limits').textContent).toBe('45–130')
    expect(screen.getByLabelText('Transitions via').textContent).toBe('Light')
    // No inputs until a row is opened.
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /Reset to default/ }).hasAttribute('disabled')).toBe(true)
  })

  it('opens a rule for editing from a dotted value and saves the edited threshold', () => {
    renderRules()
    open('Rule 2 condition 1 value')
    const field = screen.getByLabelText('Rule 2 condition 1 value') as HTMLInputElement
    expect(field.tagName).toBe('INPUT')
    expect(field.value).toBe('0.92')
    // Other rows stay as sentences.
    expect(screen.getByLabelText('Rule 1 condition 1 value').tagName).toBe('BUTTON')
    fireEvent.change(field, { target: { value: '0.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByLabelText('Rule 2 condition 1 value').textContent).toBe('0.9')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({
      side: 'left',
      classifier: { engine: 'rules', ruleset: expect.objectContaining({ fallback: 'light' }) },
    })
    expect(savedRuleset().rules[1].when[0]).toEqual({ metric: 'hrRatio', op: '<', value: 0.9 })
  })

  it('disables the editor while a save is pending so the refetch cannot drop edits', () => {
    trpcMock.state.savePending = true
    renderRules()
    // Disabled via the enclosing <fieldset>, so check the effective state, not the attribute.
    expect(screen.getByLabelText('Rule 2 condition 1 value').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Fallback stage').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Move rule 2 up').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText('Wake sensitivity').matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Discard' }).matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Saving…' }).matches(':disabled')).toBe(true)
  })

  it('reorders, removes and adds rules and conditions', () => {
    renderRules()
    fireEvent.click(screen.getByLabelText('Move rule 2 up'))
    fireEvent.click(screen.getByLabelText('Remove rule 5'))
    open('Rule 3 condition 3 value')
    fireEvent.click(screen.getByLabelText('Remove rule 3 condition 3'))
    open('Rule 1 stage')
    fireEvent.click(screen.getByRole('button', { name: 'Condition' }))
    // Adding a rule opens it for editing with a default condition.
    fireEvent.click(screen.getByRole('button', { name: 'Rule' }))
    expect((screen.getByLabelText('Rule 5 stage') as HTMLSelectElement).tagName).toBe('SELECT')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const rules = savedRuleset().rules
    expect(rules.map((r: { stage: string }) => r.stage)).toEqual(['deep', 'wake', 'rem', 'rem', 'wake'])
    expect(rules[0].when).toHaveLength(2)
    expect(rules[2].when).toHaveLength(2)
    expect(rules[4]).toEqual({ stage: 'wake', when: [{ metric: 'movement', op: '>', value: 100 }] })
  })

  it('edits signal limits, smoothing, transitions and the fallback', () => {
    renderRules()
    open('Heart rate (bpm) limits')
    fireEvent.change(screen.getByLabelText('Heart rate (bpm) minimum'), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Smooth single-epoch blips' }))
    open('Transition 1 from')
    fireEvent.click(screen.getByLabelText('Remove transition 4'))
    open('Fallback stage')
    fireEvent.change(screen.getByLabelText('Fallback stage'), { target: { value: 'deep' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const r = savedRuleset()
    expect(r.outliers.heartRate).toEqual({ min: 40, max: 130 })
    expect(r.smoothIsolatedEpochs).toBe(false)
    expect(r.transitions).toHaveLength(3)
    expect(r.fallback).toBe('deep')
  })

  it('reads symmetric transitions as pairs and adds the next pair', () => {
    renderRules()
    const row = screen.getByLabelText('Transition 1 from').closest('div') as HTMLElement
    expect(row.textContent).toContain('Never jump directly between Wake and Deep, or Deep and REM; pass through Light')
    fireEvent.click(screen.getByRole('button', { name: '+ pair' }))
    expect((screen.getByLabelText('Transition 5 from') as HTMLSelectElement).value).toBe('wake')
    expect((screen.getByLabelText('Transition 6 from') as HTMLSelectElement).value).toBe('rem')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(savedRuleset().transitions).toHaveLength(6)
  })

  it('moves the matching rule value from a quick adjust slider', () => {
    renderRules()
    fireEvent.change(screen.getByLabelText('Wake sensitivity'), { target: { value: '240' } })
    expect(screen.getByLabelText('Rule 1 condition 1 value').textContent).toBe('240')
    expect(screen.getByText(/200 → 240/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Deep sleep'), { target: { value: '0.9' } })
    expect(screen.getByLabelText('Rule 2 condition 1 value').textContent).toBe('0.9')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(savedRuleset().rules[0].when[0].value).toBe(240)
    expect(savedRuleset().rules[1].when[0].value).toBe(0.9)
  })

  it('loads a preset into the draft and discards back to the saved rules', () => {
    renderRules()
    fireEvent.change(screen.getByLabelText('Start from preset'), { target: { value: 'movementOnly' } })
    expect(screen.queryByLabelText('Rule 2 stage')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('Rule 2 stage')).toBeTruthy()
  })

  it('blocks saving an invalid ruleset', () => {
    renderRules()
    open('HRV (ms) limits')
    fireEvent.change(screen.getByLabelText('HRV (ms) minimum'), { target: { value: '400' } })
    expect(screen.getByText('min must be less than or equal to max')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('resets custom rules to the defaults with a null classifier', () => {
    trpcMock.state.classifier = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }
    trpcMock.state.isDefault = false
    renderRules()
    expect(screen.getByText('Profile: Custom rules')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/ }))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({ side: 'left', classifier: null })
  })

  it('previews the draft after a pause and shows what it would change', () => {
    trpcMock.state.preview = PREVIEW
    renderRules()
    expect(trpcMock.previewMutate).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(400))
    expect(trpcMock.previewMutate).toHaveBeenCalledWith({ side: 'left', nights: 1, classifier: { engine: 'rules', ruleset: DEFAULT_STAGE_RULESET } })

    expect(screen.getByText('Q 88 · κ 0.74')).toBeTruthy()
    expect(screen.getByText('Q 89 · κ 0.77')).toBeTruthy()
    expect(screen.getByText('38m → 41m')).toBeTruthy()
    expect(screen.getByText('1h 5m → 1h 12m')).toBeTruthy()
    expect(screen.getByText('84% → 86%')).toBeTruthy()
    expect(screen.getByLabelText('Changed epochs').children).toHaveLength(1)

    // Per-rule statistics from the candidate run.
    expect(screen.getByText('8% of epochs')).toBeTruthy()
    expect(screen.getByText('59% of epochs')).toBeTruthy()
    expect(screen.getByText('Never fires: every epoch it matches is taken by rule 3.')).toBeTruthy()
    // Rule 1 and low-signal rule 1 both test movement alone.
    expect(screen.getAllByText(/last night 0–412/)).toHaveLength(2)
    expect(screen.getByText(/last night 48–96 · 9–118 · 11–17/)).toBeTruthy()
    expect(screen.getByText(/dropped 3% of readings last night/)).toBeTruthy()
    expect(screen.getByText(/fixed 6 last night/)).toBeTruthy()
    expect(screen.getByText(/4 transitions last night/)).toBeTruthy()
    // Quick adjust reads the per-night effect.
    expect(screen.getByText(/\+3 min wake \/ night/)).toBeTruthy()
  })

  it('previews the last 7 nights when asked', () => {
    renderRules()
    fireEvent.click(screen.getByRole('tab', { name: '7 nights' }))
    act(() => vi.advanceTimersByTime(400))
    expect(trpcMock.previewMutate).toHaveBeenLastCalledWith(expect.objectContaining({ nights: 7 }))
  })

  it('does not preview an invalid draft', () => {
    renderRules()
    open('HRV (ms) limits')
    fireEvent.change(screen.getByLabelText('HRV (ms) minimum'), { target: { value: '400' } })
    act(() => vi.advanceTimersByTime(1000))
    expect(trpcMock.previewMutate).not.toHaveBeenCalled()
  })

  it('lists recent changes with their effect and reverts one', () => {
    const before: StageClassifier = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }
    trpcMock.state.changes = [
      { id: 2, changedAt: Date.UTC(2026, 9, 9, 12), summary: 'Wake movement 200 → 240', before, agreementBefore: 0.84, agreementAfter: 0.86 },
      { id: 1, changedAt: Date.UTC(2026, 9, 6, 12), summary: 'Reset to default', before: null, agreementBefore: null, agreementAfter: null },
    ]
    renderRules()
    expect(screen.getByText(/Profile: System defaults · changed Oct 9/)).toBeTruthy()
    const changes = screen.getByText('Changes').parentElement as HTMLElement
    expect(within(changes).getByText('watch 84% → 86%')).toBeTruthy()
    expect(within(changes).getByText('no watch data')).toBeTruthy()
    fireEvent.click(within(changes).getAllByRole('button', { name: 'Revert' })[0])
    expect(trpcMock.setMutate).toHaveBeenCalledWith({ side: 'left', classifier: before })
  })
})
