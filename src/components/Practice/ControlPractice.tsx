'use client'

import { useEffect, useId, useReducer, useRef } from 'react'
import { AlarmClock, Check, CircleStop, Power, Thermometer } from 'lucide-react'
import { initialControlPractice, PRACTICE_LESSONS, practiceCompletion, practiceWarmTime, reduceControlPractice, validPracticeTime } from '@/src/lib/controlPractice'
import type { PracticeSurface } from '@/src/lib/controlPractice'

const lessonNames = { temperature: 'Temperature', wake: 'Tomorrow’s alarm', stop: 'Stop an action' }
const lessonIcons = { temperature: Thermometer, wake: AlarmClock, stop: CircleStop }

/** The same local lessons open in the owner app and the isolated personal workspace. */
export function ControlPractice({ onClose, surface = 'owner' }: { onClose: () => void, surface?: PracticeSurface }) {
  const [state, dispatch] = useReducer(reduceControlPractice, surface, initialControlPractice)
  const needsApply = state.surface === 'personal'
  const headingId = useId(), lessonId = useId(), timeId = useId()
  const lessonHeading = useRef<HTMLHeadingElement>(null)
  const completed = practiceCompletion(state)
  const completedCount = PRACTICE_LESSONS.filter(lesson => completed[lesson]).length
  const lessonIndex = PRACTICE_LESSONS.indexOf(state.lesson)
  useEffect(() => {
    lessonHeading.current?.focus()
  }, [state.lesson])
  return (
    <section className="control-practice" aria-labelledby={headingId}>
      <div className="practice-header">
        <div>
          <h2 id={headingId}>Practice the bed controls</h2>
          <p>Try three everyday actions with example settings. Your bed and real alarms stay unchanged.</p>
        </div>
        <button type="button" onClick={onClose}>Leave practice</button>
      </div>
      <nav aria-label="Practice lessons">
        <ol className="practice-lessons">
          {PRACTICE_LESSONS.map((lesson) => {
            const Icon = lessonIcons[lesson]
            return (
              <li key={lesson}>
                <button type="button" aria-current={state.lesson === lesson ? 'step' : undefined} onClick={() => dispatch({ type: 'lesson', lesson })}>
                  {completed[lesson] ? <Check size={20} aria-hidden /> : <Icon size={20} aria-hidden />}
                  <span>
                    {lessonNames[lesson]}
                    {completed[lesson] && <small>Practiced</small>}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </nav>
      <div className="practice-lesson" aria-labelledby={lessonId}>
        <h3 id={lessonId} ref={lessonHeading} tabIndex={-1}>{state.lesson === 'temperature' ? 'Try a cooler target.' : state.lesson === 'wake' ? 'Give tomorrow a later start.' : 'Know what each Stop does.'}</h3>
        {state.lesson === 'temperature' && (
          <>
            <p>
              {needsApply ? 'Choose a target, then select Apply my target in your personal controls.' : 'A cooler or warmer tap requests a new target right away.'}
              {' '}
              In the real app, measured water temperature can take time to reach your target.
            </p>
            <div className="practice-temperature">
              <div className="practice-zone" role="img" aria-label={`Example side, requested target ${state.appliedTargetF} degrees Fahrenheit`}>
                <span className="practice-pillow" aria-hidden />
                <span>Example side</span>
                <strong>
                  {state.appliedTargetF}
                  °F
                </strong>
                <span>Requested practice target</span>
              </div>
              <div className="practice-adjustment">
                {needsApply && (
                  <p>
                    New practice target:
                    {' '}
                    <strong>
                      {state.draftTargetF}
                      °F
                    </strong>
                  </p>
                )}
                <div className="practice-actions">
                  <button type="button" disabled={state.draftTargetF <= 65} onClick={() => dispatch({ type: 'temperature.step', degrees: -1 })}>1°F cooler</button>
                  <button type="button" disabled={state.draftTargetF >= 90} onClick={() => dispatch({ type: 'temperature.step', degrees: 1 })}>1°F warmer</button>
                </div>
                {needsApply && <button type="button" className="practice-primary" disabled={state.draftTargetF === state.appliedTargetF} onClick={() => dispatch({ type: 'temperature.apply' })}>Apply my target</button>}
                <p className="practice-feedback" role="status">{state.draftTargetF !== state.appliedTargetF ? 'Chosen, not requested yet.' : completed.temperature ? `Example request changed to ${state.appliedTargetF}°F. Your real bed did not change.` : 'Try choosing one degree cooler.'}</p>
              </div>
            </div>
          </>
        )}
        {state.lesson === 'wake' && (
          <>
            <p>This example normally wakes at 07:00. Move tomorrow’s example to a later time, review it, then save. The regular week stays the same.</p>
            <label htmlFor={timeId}>Tomorrow’s practice wake time</label>
            <input id={timeId} type="time" value={state.draftWake} onChange={event => dispatch({ type: 'wake.edit', time: event.target.value })} />
            <button type="button" disabled={!validPracticeTime(state.draftWake) || state.draftWake === state.savedWake} onClick={() => dispatch({ type: 'wake.review' })}>Review practice alarm</button>
            {state.reviewedWake && (
              <div className="practice-wake-review">
                <h4>Tomorrow’s example</h4>
                <dl>
                  <div>
                    <dt>Warming starts</dt>
                    <dd>{practiceWarmTime(state.reviewedWake)}</dd>
                  </div>
                  <div>
                    <dt>Vibration</dt>
                    <dd>
                      {state.reviewedWake}
                      {' '}
                      · 20 seconds
                    </dd>
                  </div>
                  <div>
                    <dt>Regular week</dt>
                    <dd>Still 07:00</dd>
                  </div>
                </dl>
                <p>Phone alarms and wake-up lights are separate. A Pod change alone does not confirm that they changed.</p>
                <button type="button" className="practice-primary" onClick={() => dispatch({ type: 'wake.save' })}>Save practice alarm</button>
              </div>
            )}
            <p className="practice-feedback" role="status">{!validPracticeTime(state.draftWake) ? 'Choose a valid time to review.' : completed.wake ? `Tomorrow’s example is saved for ${state.savedWake}. No real alarm changed.` : `Saved example: ${state.savedWake}. Choose a time and review it before saving.`}</p>
          </>
        )}
        {state.lesson === 'stop' && (
          <>
            <p>
              {needsApply ? 'Stop temperature stops heating and cooling in your personal controls.' : 'The power symbol turns off heating and cooling in the bed controls.'}
              {' '}
              Vibration has its own Stop. Neither deletes the next scheduled alarm.
            </p>
            <dl className="practice-stop-state">
              <div>
                <dt>Example temperature</dt>
                <dd>{state.temperatureOn ? 'On' : 'Off'}</dd>
              </div>
              <div>
                <dt>Example vibration</dt>
                <dd>{state.vibrationOn ? 'Playing' : 'Stopped'}</dd>
              </div>
              <div>
                <dt>Next example alarm</dt>
                <dd>
                  {state.savedWake}
                  {' '}
                  · still saved
                </dd>
              </div>
            </dl>
            <div className="practice-actions">
              <button type="button" disabled={!state.temperatureOn} onClick={() => dispatch({ type: 'stop.temperature' })}>
                {!needsApply && <Power size={20} aria-hidden />}
                {needsApply ? 'Stop temperature' : 'Turn off'}
              </button>
              <button type="button" disabled={!state.vibrationOn} onClick={() => dispatch({ type: 'stop.vibration' })}>Stop vibration</button>
            </div>
            <p className="practice-feedback" role="status">{completed.stop ? 'Both example actions stopped. Your real bed is unchanged.' : 'The next scheduled alarm stays saved when you press Stop.'}</p>
          </>
        )}
        <div className="practice-footer">
          <p>
            {completedCount}
            {' '}
            of 3 actions practiced
            {completedCount === 3 ? '. You can return to your account when you’re ready.' : '.'}
          </p>
          {lessonIndex < 2 && <button type="button" className="practice-primary" onClick={() => dispatch({ type: 'lesson', lesson: PRACTICE_LESSONS[lessonIndex + 1] })}>{completed[state.lesson] ? 'Next lesson' : 'Skip to next lesson'}</button>}
          {lessonIndex === 2 && <button type="button" className="practice-primary" onClick={onClose}>Finish practice</button>}
        </div>
      </div>
      <div className="practice-links">
        <a href="/guide/marissa.html">Open the illustrated guide</a>
        <button type="button" onClick={() => dispatch({ type: 'reset' })}>Restart practice</button>
      </div>
      <p className="practice-small">Practice choices disappear when you leave. To join the household, use your personal invitation. You never need the owner’s connection key.</p>
    </section>
  )
}
