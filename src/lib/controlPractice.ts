/** Local examples only. This module has no controller, account, storage or network dependency. */
export const PRACTICE_LESSONS = ['temperature', 'wake', 'stop'] as const
export type PracticeLesson = typeof PRACTICE_LESSONS[number]
export type PracticeSurface = 'owner' | 'personal'
export interface ControlPracticeState {
  surface: PracticeSurface
  lesson: PracticeLesson
  draftTargetF: number
  appliedTargetF: number
  temperatureTried: boolean
  draftWake: string
  savedWake: string
  reviewedWake: string | null
  wakeTried: boolean
  temperatureOn: boolean
  vibrationOn: boolean
}
export type ControlPracticeAction
  = | { type: 'lesson', lesson: PracticeLesson }
    | { type: 'temperature.step', degrees: -1 | 1 }
    | { type: 'temperature.apply' }
    | { type: 'wake.edit', time: string }
    | { type: 'wake.review' }
    | { type: 'wake.save' }
    | { type: 'stop.temperature' }
    | { type: 'stop.vibration' }
    | { type: 'reset' }

export function initialControlPractice(surface: PracticeSurface = 'owner'): ControlPracticeState {
  return { surface, lesson: 'temperature', draftTargetF: 76, appliedTargetF: 76, temperatureTried: false,
    draftWake: '08:00', savedWake: '07:00', reviewedWake: null, wakeTried: false,
    temperatureOn: true, vibrationOn: true }
}

export function validPracticeTime(time: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
}

/** Wrap the example's 30-minute warming lead across midnight without using the device timezone. */
export function practiceWarmTime(wake: string): string | null {
  if (!validPracticeTime(wake)) return null
  const [hours, minutes] = wake.split(':').map(Number)
  const earlier = (hours * 60 + minutes - 30 + 1440) % 1440
  return `${String(Math.floor(earlier / 60)).padStart(2, '0')}:${String(earlier % 60).padStart(2, '0')}`
}

export function practiceCompletion(state: ControlPracticeState): Record<PracticeLesson, boolean> {
  return {
    temperature: state.temperatureTried && state.draftTargetF === state.appliedTargetF,
    wake: state.wakeTried && state.draftWake === state.savedWake,
    stop: !state.temperatureOn && !state.vibrationOn,
  }
}

/** Advance an example only after its deliberate action; changing a reviewed alarm invalidates that review. */
export function reduceControlPractice(state: ControlPracticeState, action: ControlPracticeAction): ControlPracticeState {
  switch (action.type) {
    case 'reset': return initialControlPractice(state.surface)
    case 'lesson': return { ...state, lesson: action.lesson }
    case 'temperature.step': {
      const target = Math.max(65, Math.min(90, state.draftTargetF + action.degrees))
      // Owner taps request immediately; personal web controls require Apply my target.
      return { ...state, draftTargetF: target,
        ...(state.surface === 'owner' ? { appliedTargetF: target, temperatureTried: state.temperatureTried || target !== 76 } : {}) }
    }
    case 'temperature.apply': return state.surface === 'personal'
      ? { ...state, appliedTargetF: state.draftTargetF, temperatureTried: state.temperatureTried || state.draftTargetF !== 76 }
      : state
    case 'wake.edit': return { ...state, draftWake: action.time, reviewedWake: null }
    case 'wake.review': return { ...state, reviewedWake: validPracticeTime(state.draftWake) ? state.draftWake : null }
    case 'wake.save': return state.reviewedWake === state.draftWake && validPracticeTime(state.draftWake)
      ? { ...state, savedWake: state.draftWake, wakeTried: state.wakeTried || state.draftWake !== '07:00', reviewedWake: null }
      : state
    case 'stop.temperature': return { ...state, temperatureOn: false }
    case 'stop.vibration': return { ...state, vibrationOn: false }
  }
}
