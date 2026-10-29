/**
 * SleepStageRules — rules as sentences with click-to-edit values, the quick
 * adjust sliders, saving / resetting / reverting payloads, presets,
 * validation, and the debounced preview with its per-rule statistics.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STAGE_CLASSIFIER,
  DEFAULT_STAGE_RULESET,
  MOVEMENT_ONLY_STAGE_RULESET,
  type StageClassifier,
  type StageRuleset,
} from '@/src/lib/sleep-stage-rules'

const trpcMock = vi.hoisted(() => {
  const setMutate = vi.fn()
  const previewMutate = vi.fn()
  const activeMutate = vi.fn()
  const invalidate = vi.fn()
  const state = {
    model: { model: null, uploadedAt: null, active: false } as { model: { version: string, kind: string, metrics?: Record<string, unknown> } | null, uploadedAt: number | null, active: boolean },
    activeError: null as { message: string } | null,
    classifier: null as unknown as StageClassifier,
    pending: null as { classifier: StageClassifier, generation: number, warning: string | null } | null,
    movementOnly: null as unknown as StageClassifier['ruleset'],
    isDefault: true,
    changes: [] as unknown[],
    preview: undefined as unknown,
    savePending: false,
    saveError: null as { message: string } | null,
    saveOptions: null as { onSuccess?: () => void } | null,
    queryError: null as { message: string } | null,
    loading: false,
    previewError: null as { message: string } | null,
    previewPending: false,
  }
  return {
    setMutate,
    previewMutate,
    activeMutate,
    invalidate,
    state,
    trpc: {
      useUtils: () => ({ sleepStages: { getClassifier: { invalidate }, getModel: { invalidate: vi.fn() }, listModels: { invalidate: vi.fn() } }, biometrics: { getSleepStages: { invalidate: vi.fn() } } }),
      sleepStages: {
        getModel: { useQuery: () => ({ data: state.model }) },
        listModels: { useQuery: () => ({ data: [] }) },
        uploadModel: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
        selectModel: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        setModelActive: { useMutation: () => ({ mutate: activeMutate, isPending: false, error: state.activeError }) },
        getClassifier: {
          useQuery: () => ({
            data: state.loading || state.queryError
              ? undefined
              : {
                  classifier: state.classifier,
                  pending: state.pending,
                  isDefault: state.isDefault,
                  changes: state.changes,
                  presets: [
                    { id: 'default', label: 'Default', description: '', classifier: { engine: 'rules', ruleset: state.classifier.ruleset } },
                    { id: 'movementOnly', label: 'Movement only', description: '', classifier: { engine: 'rules', ruleset: state.movementOnly } },
                  ],
                },
            isLoading: state.loading,
            error: state.queryError,
          }),
        },
        setClassifier: {
          useMutation: (options: { onSuccess?: () => void }) => {
            state.saveOptions = options
            return { mutate: setMutate, isPending: state.savePending, error: state.saveError }
          },
        },
        previewClassifier: { useMutation: () => ({ mutate: previewMutate, data: state.preview, error: state.previewError, isPending: state.previewPending }) },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Left', rightName: 'Right', sideName: (s: string) => s }) }))

import { SleepStageRules } from '../SleepStageRules'
import type { PreviewOutput } from '../SleepStagePreview'
import { move } from '../SleepStageRows'

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

/** No wake/movement or deep/hrRatio rule, a rule with no conditions, spikes off, no low-signal rules or transitions. */
const CUSTOM_RULESET: StageRuleset = {
  ...DEFAULT_STAGE_RULESET,
  outliers: { ...DEFAULT_STAGE_RULESET.outliers, heartRateSpikeStdDevs: 0 },
  lowSignalRules: [],
  rules: [
    { stage: 'rem', when: [] },
    { stage: 'light', when: [{ metric: 'hrv', op: '>', value: 50 }] },
  ],
  transitions: [],
}

type PreviewStats = NonNullable<PreviewOutput['candidate']>['stats']
const customStats = (over: Partial<PreviewStats>) => ({
  ...PREVIEW,
  candidate: { ...PREVIEW.candidate, stats: { ...PREVIEW.candidate.stats, ...over } },
})

beforeEach(() => {
  vi.useFakeTimers()
  trpcMock.setMutate.mockClear()
  trpcMock.previewMutate.mockClear()
  trpcMock.invalidate.mockClear()
  Object.assign(trpcMock.state, {
    classifier: DEFAULT_STAGE_CLASSIFIER,
    pending: null,
    isDefault: true,
    changes: [],
    preview: undefined,
    movementOnly: MOVEMENT_ONLY_STAGE_RULESET,
    savePending: false,
    saveError: null,
    saveOptions: null,
    queryError: null,
    loading: false,
    previewError: null,
    previewPending: false,
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

  it('edits pending rules while showing adoption status and allowing reset', () => {
    trpcMock.state.pending = { classifier: { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }, generation: 7, warning: null }
    renderRules()
    expect(screen.getByRole('status').textContent).toContain('waiting for processor adoption')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByLabelText('Rule 2 stage')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/ }))
    expect(trpcMock.setMutate).toHaveBeenCalledWith({ side: 'left', classifier: null })
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

  it('hides the last preview while the draft is invalid', () => {
    trpcMock.state.preview = PREVIEW
    renderRules()
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByText('Q 89 · κ 0.77')).toBeTruthy()
    open('HRV (ms) limits')
    fireEvent.change(screen.getByLabelText('HRV (ms) minimum'), { target: { value: '400' } })
    expect(screen.queryByText('Q 89 · κ 0.77')).toBeNull()
    fireEvent.change(screen.getByLabelText('HRV (ms) minimum'), { target: { value: '5' } })
    expect(screen.getByText('Q 89 · κ 0.77')).toBeTruthy()
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

  it('shows the query error instead of the editor', () => {
    trpcMock.state.queryError = { message: 'db offline' }
    renderRules()
    expect(screen.getByText('Failed to load sleep stage rules: db offline')).toBeTruthy()
    expect(screen.queryByText('Stage rules')).toBeNull()
  })

  it('shows skeletons while the rules load and never previews', () => {
    trpcMock.state.loading = true
    renderRules()
    expect(screen.queryByText(/Profile:/)).toBeNull()
    act(() => vi.advanceTimersByTime(1000))
    expect(trpcMock.previewMutate).not.toHaveBeenCalled()
  })

  it('shows the save error and refetches the rules after a save succeeds', () => {
    trpcMock.state.saveError = { message: 'Save failed' }
    renderRules()
    expect(screen.getByText('Save failed')).toBeTruthy()
    act(() => trpcMock.state.saveOptions?.onSuccess?.())
    expect(trpcMock.invalidate).toHaveBeenCalledWith({ side: 'left' })
  })

  it('reads a custom ruleset: always-rules, no quick adjust, spikes off, no transitions', () => {
    trpcMock.state.classifier = { engine: 'rules', ruleset: CUSTOM_RULESET }
    trpcMock.state.isDefault = false
    trpcMock.state.preview = customStats({
      rules: { epochs: 100, hits: [0, 40], matches: [100, 40], shadowedBy: [null, null], fallbackHits: 60 },
      lowSignalRules: { epochs: 0, hits: [], matches: [], shadowedBy: [], fallbackHits: 0 },
      metricRanges: { hrRatio: null, heartRate: null, hrv: null, breathingRate: null, movement: null },
    })
    renderRules()
    act(() => vi.advanceTimersByTime(400))

    expect(screen.queryByText('Quick adjust')).toBeNull()
    expect(screen.getByText('always')).toBeTruthy()
    expect(screen.getByText('Never fires on these nights.')).toBeTruthy()
    expect(screen.getByText('(off)')).toBeTruthy()
    expect(screen.queryByText(/dropped/)).toBeNull()
    expect(screen.getByText('Any stage may follow any other')).toBeTruthy()
    expect(screen.queryByText(/transitions last night/)).toBeNull()
    // No metric ranges: no "· last night 0–412" tails on rules or limits.
    expect(screen.queryByText(/· last night \d/)).toBeNull()

    // The empty rule reads "always" while editing too.
    open('Rule 1 stage')
    expect(screen.getByText('always')).toBeTruthy()

    // The nested add button appends a low-signal rule and opens it.
    fireEvent.click(screen.getByRole('button', { name: '+ Low-signal rule' }))
    expect(screen.getByLabelText('Low-signal rule 1 stage').tagName).toBe('SELECT')
    fireEvent.change(screen.getByLabelText('Low-signal rule 1 stage'), { target: { value: 'light' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(savedRuleset().lowSignalRules).toEqual([{ stage: 'light', when: [{ metric: 'movement', op: '>', value: 100 }] }])
  })

  it('ignores per-rule stats that do not describe the current rules', () => {
    trpcMock.state.preview = customStats({
      rules: { epochs: 100, hits: [8, 14, 17], matches: [8, 14, 17], shadowedBy: [null, null, null], fallbackHits: 59 },
      lowSignalRules: { epochs: 50, hits: [10], matches: [10], shadowedBy: [null], fallbackHits: 40 },
    })
    renderRules()
    act(() => vi.advanceTimersByTime(400))
    expect(screen.queryByText(/% of epochs/)).toBeNull()
    expect(screen.queryByText(/Never fires/)).toBeNull()
    // The low-signal list is aligned, so its bar shows.
    expect(screen.getByText('20% on those nights')).toBeTruthy()
  })

  it('keeps the edited rule open when moved and closes it when removed', () => {
    renderRules()
    open('Rule 2 stage')
    fireEvent.click(screen.getByLabelText('Move rule 2 up'))
    expect((screen.getByLabelText('Rule 1 stage') as HTMLSelectElement).value).toBe('deep')
    expect(screen.getByLabelText('Rule 2 stage').tagName).toBe('BUTTON')
    fireEvent.click(screen.getByLabelText('Move rule 1 down'))
    expect((screen.getByLabelText('Rule 2 stage') as HTMLSelectElement).value).toBe('deep')
    fireEvent.click(screen.getByLabelText('Remove rule 2'))
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.getByLabelText('Rule 2 stage').textContent).toBe('REM')
  })

  it('leaves the list alone when moving out of range', () => {
    const list = ['a', 'b']
    expect(move(list, 0, -1)).toBe(list)
    expect(move(list, 1, 2)).toBe(list)
    expect(move(list, 0, 1)).toEqual(['b', 'a'])
  })

  it('changes a condition metric and comparison while editing', () => {
    renderRules()
    open('Rule 1 condition 1')
    fireEvent.change(screen.getByLabelText('Rule 1 condition 1 metric'), { target: { value: 'hrv' } })
    fireEvent.change(screen.getByLabelText('Rule 1 condition 1 comparison'), { target: { value: '<=' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByLabelText('Rule 1 condition 1').textContent).toBe('HRV ≤')
    expect(screen.getByLabelText('Rule 1 condition 1 value').textContent).toBe('200 ms')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(savedRuleset().rules[0].when[0]).toEqual({ metric: 'hrv', op: '<=', value: 200 })
  })

  it('finishes editing the limits, spike, low-signal and fallback rows with Done', () => {
    renderRules()
    open('Heart rate (bpm) limits')
    fireEvent.change(screen.getByLabelText('Heart rate (bpm) maximum'), { target: { value: '140' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByLabelText('Heart rate (bpm) limits').textContent).toBe('45–140')

    open('Heart-rate spike threshold')
    fireEvent.change(screen.getByLabelText('Heart-rate spike threshold'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByLabelText('Heart-rate spike threshold').tagName).toBe('BUTTON')
    expect(screen.getByLabelText('Heart-rate spike threshold').textContent).toBe('3')

    open('Low-signal threshold')
    fireEvent.change(screen.getByLabelText('Low-signal threshold'), { target: { value: '0.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByLabelText('Low-signal threshold').textContent).toBe('0.5')

    open('Fallback stage')
    expect(screen.getByLabelText('Fallback stage').tagName).toBe('SELECT')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByLabelText('Fallback stage').tagName).toBe('BUTTON')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const r = savedRuleset()
    expect(r.outliers.heartRate).toEqual({ min: 45, max: 140 })
    expect(r.outliers.heartRateSpikeStdDevs).toBe(3)
    expect(r.lowSignalBelow).toBe(0.5)
  })

  it('reads mixed transitions with their via and edits them in place', () => {
    trpcMock.state.classifier = {
      engine: 'rules',
      ruleset: {
        ...DEFAULT_STAGE_RULESET,
        transitions: [
          { from: 'wake', to: 'deep', via: 'light' },
          { from: 'deep', to: 'wake', via: 'light' },
          { from: 'rem', to: 'light', via: 'wake' },
        ],
      },
    }
    renderRules()
    const row = screen.getByLabelText('Transition 1 from').closest('div') as HTMLElement
    expect(row.textContent).toContain('Never jump directly between Wake and Deep via Light, or from REM to Light via Wake')
    expect(screen.queryByLabelText('Transitions via')).toBeNull()

    open('Transition 3 via')
    expect(screen.getByText('Transitions that must pass through another stage')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Transition 1 from'), { target: { value: 'light' } })
    fireEvent.change(screen.getByLabelText('Transition 1 to'), { target: { value: 'rem' } })
    fireEvent.change(screen.getByLabelText('Transition 3 via'), { target: { value: 'deep' } })
    fireEvent.click(screen.getByRole('button', { name: 'Transition' }))
    expect((screen.getByLabelText('Transition 4 to') as HTMLSelectElement).value).toBe('deep')
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(screen.getByLabelText('Transition 6 from')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove transition 2'))
    expect(screen.queryByLabelText('Transition 6 from')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByLabelText('Transition 1 from').tagName).toBe('BUTTON')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const t = savedRuleset().transitions
    expect(t).toHaveLength(5)
    expect(t[0]).toEqual({ from: 'light', to: 'rem', via: 'light' })
    expect(t[1]).toEqual({ from: 'rem', to: 'light', via: 'deep' })
    expect(t[2]).toEqual({ from: 'wake', to: 'deep', via: 'light' })
  })

  it('hides the quick adjust readout arrow until a value changes and reads unchanged without a preview', () => {
    renderRules()
    expect(screen.queryByText(/→/)).toBeNull()
    expect(screen.getAllByText(/· unchanged/)).toHaveLength(2)
  })

  it('previews 7 nights with per-night labels and the low-signal night count', () => {
    trpcMock.state.preview = { ...customStats({ lowSignalNights: 2 }), nights: 7 }
    renderRules()
    fireEvent.click(screen.getByRole('tab', { name: '7 nights' }))
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByText('Wake per night')).toBeTruthy()
    expect(screen.getByText('Deep per night')).toBeTruthy()
    expect(screen.getByText(/2 of the last 7 nights/)).toBeTruthy()
    expect(screen.getAllByText(/last 7 nights 0–412/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('tab', { name: 'Last night' }))
    act(() => vi.advanceTimersByTime(400))
    expect(trpcMock.previewMutate).toHaveBeenLastCalledWith(expect.objectContaining({ nights: 1 }))
    expect(screen.queryByText('Wake per night')).toBeNull()
  })

  it('says when the low-signal rules were used last night', () => {
    trpcMock.state.preview = customStats({ lowSignalNights: 1 })
    renderRules()
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByText(/· used last night/)).toBeTruthy()
  })

  it('previews a candidate without saved stages, kappa, watch reference or changed strip', () => {
    trpcMock.state.preview = {
      ...PREVIEW,
      hasReference: false,
      enteredBedAt: null,
      leftBedAt: null,
      changed: null,
      saved: null,
      candidate: { ...PREVIEW.candidate, agreement: null },
    }
    renderRules()
    act(() => vi.advanceTimersByTime(400))
    expect(screen.queryByLabelText('Saved quality')).toBeNull()
    expect(screen.getByLabelText('These rules quality').textContent).toBe('Q 89')
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getByText(/Import Apple Watch stages/)).toBeTruthy()
    expect(screen.queryByLabelText('Changed epochs')).toBeNull()
    expect(screen.getAllByText(/· unchanged/)).toHaveLength(2)
  })

  it('shows one value when the saved and candidate deltas are equal', () => {
    trpcMock.state.preview = {
      ...PREVIEW,
      candidate: { ...PREVIEW.saved, agreement: { epochs: 90, accuracy: 0.84, kappa: null } },
    }
    renderRules()
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByText('38m')).toBeTruthy()
    expect(screen.getByText('84%')).toBeTruthy()
    expect(screen.getByLabelText('These rules quality').textContent).toBe('Q 88')
  })

  it('previews saved stages without a candidate', () => {
    trpcMock.state.preview = { ...PREVIEW, candidate: null, changed: null }
    renderRules()
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByLabelText('Saved quality').textContent).toBe('Q 88 · κ 0.74')
    expect(screen.queryByLabelText('These rules quality')).toBeNull()
    expect(screen.getAllByText('—')).toHaveLength(3)
  })

  it('says when there is no night to preview', () => {
    trpcMock.state.preview = { ...PREVIEW, saved: null, candidate: null }
    renderRules()
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByText('No night with vitals to preview yet.')).toBeTruthy()
  })

  it('shows the preview error and keeps the last result steady while it reloads', () => {
    trpcMock.state.previewError = { message: 'Preview failed' }
    trpcMock.state.previewPending = true
    trpcMock.state.preview = PREVIEW
    renderRules()
    expect(screen.getByText('Preview failed')).toBeTruthy()
    // No dimming or placeholder while the next preview computes: the card must not visibly redraw per edit.
    expect(screen.getByText('These rules').closest('.opacity-60')).toBeNull()
    expect(screen.getByText('Q 89 · κ 0.77')).toBeTruthy()
  })

  it('keeps the last preview on screen while the mutation has dropped its data for the next request', () => {
    trpcMock.state.preview = PREVIEW
    const { rerender } = renderRules()
    act(() => vi.advanceTimersByTime(400))
    expect(screen.getByText('Q 89 · κ 0.77')).toBeTruthy()
    // Like useMutation at the start of the next call: data gone, pending.
    trpcMock.state.preview = undefined
    trpcMock.state.previewPending = true
    rerender(<SleepStageRules side="left" onSideChange={vi.fn()} />)
    expect(screen.queryByText('Q 89 · κ 0.77')).toBeTruthy()
    expect(screen.queryByText('No night with vitals to preview yet.')).toBeNull()
  })

  it('tones each change by its effect on watch agreement and disables revert while saving', () => {
    trpcMock.state.savePending = true
    trpcMock.state.changes = [
      { id: 3, changedAt: Date.UTC(2026, 9, 9, 12), summary: 'Better', before: null, agreementBefore: 0.84, agreementAfter: 0.86 },
      { id: 2, changedAt: Date.UTC(2026, 9, 8, 12), summary: 'Worse', before: null, agreementBefore: 0.8, agreementAfter: 0.7 },
      { id: 1, changedAt: Date.UTC(2026, 9, 7, 12), summary: 'Same', before: null, agreementBefore: 0.8, agreementAfter: 0.8 },
    ]
    renderRules()
    expect(screen.getByText('watch 84% → 86%').className).toContain('text-ok')
    expect(screen.getByText('watch 80% → 70%').className).toContain('text-warn')
    expect(screen.getByText('watch 80% → 80%').className).toContain('text-fg-2')
    for (const b of screen.getAllByRole('button', { name: 'Revert' })) expect(b.hasAttribute('disabled')).toBe(true)
  })

  it('discarding closes the row being edited', () => {
    renderRules()
    open('Rule 2 stage')
    fireEvent.change(screen.getByLabelText('Rule 2 stage'), { target: { value: 'rem' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('Rule 2 stage').tagName).toBe('BUTTON')
    expect(screen.getByLabelText('Rule 2 stage').textContent).toBe('Deep')
  })

  it('ignores the preset placeholder', () => {
    renderRules()
    fireEvent.change(screen.getByLabelText('Start from preset'), { target: { value: '' } })
    expect(screen.getByLabelText('Rule 2 stage')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })
  describe('personal model card', () => {
    it('says when no model is stored on the pod', () => {
      trpcMock.state.model = { model: null, uploadedAt: null, active: false }
      render(<SleepStageRules side="left" onSideChange={() => {}} />)
      expect(screen.getByText(/None stored/)).toBeTruthy()
      expect(screen.queryByRole('switch', { name: 'Stage nights with this model' })).toBeNull()
    })

    it('describes an active logistic model without metrics and shows a switch error', () => {
      trpcMock.state.model = { model: { version: 'container-logistic-test', kind: 'logistic' }, uploadedAt: 1, active: true }
      render(<SleepStageRules side="left" onSideChange={() => {}} />)
      expect(screen.getAllByText('container-logistic-test')[0]).toBeTruthy()
      expect(screen.getByText(/Nights are staged by/)).toBeTruthy()
      const toggle = screen.getByRole('switch', { name: 'Stage nights with this model' })
      expect(toggle.getAttribute('aria-checked')).toBe('true')
      fireEvent.click(toggle)
      expect(trpcMock.activeMutate).toHaveBeenCalledWith({ side: 'left', active: false })
      cleanup()
      trpcMock.state.activeError = { message: 'No valid personal stage model stored for left' }
      trpcMock.state.model = { model: { version: 'v', kind: 'forest', metrics: { lono: { kappa: null, nights: null } } }, uploadedAt: 1, active: false }
      render(<SleepStageRules side="left" onSideChange={() => {}} />)
      expect(screen.getByText('No valid personal stage model stored for left')).toBeTruthy()
      expect(screen.getByText('v')).toBeTruthy()
      trpcMock.state.activeError = null
    })

    it('shows the stored model and switches staging to it', () => {
      trpcMock.state.model = {
        model: { version: 'container-forest-test', kind: 'forest', metrics: { lono: { kappa: 0.25, nights: 11 } } },
        uploadedAt: 1,
        active: false,
      }
      render(<SleepStageRules side="left" onSideChange={() => {}} />)
      expect(screen.getByText('container-forest-test')).toBeTruthy()
      expect(screen.getByLabelText('κ 0.25')).toBeTruthy()
      fireEvent.click(screen.getByRole('switch', { name: 'Stage nights with this model' }))
      expect(trpcMock.activeMutate).toHaveBeenCalledWith({ side: 'left', active: true })
    })
  })
})
