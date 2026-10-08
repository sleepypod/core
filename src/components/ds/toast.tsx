'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { NOTICE_BAR, NOTICE_TEXT, type Notice } from './notice'

/** A toast is a success / info notice: no actions, no X. */
export type ToastNotice = Pick<Notice, 'id' | 'tone' | 'icon' | 'title' | 'detail'> & { kind: 'success' | 'info' }

export const TOAST_DURATION_MS = 4000
/** Enter and leave both take this long (globals.css sp-toast-in / sp-toast-out). */
export const TOAST_ANIMATION_MS = 250

interface Entry {
  notice: ToastNotice
  /** Bumped on every show so a same-id replacement restarts the countdown. */
  key: number
}

interface State {
  current: Entry | null
  queue: Entry[]
  leaving: boolean
}

type Action = { type: 'show', entry: Entry } | { type: 'expire' } | { type: 'next' }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'show': {
      const { entry } = action
      if (state.current?.notice.id === entry.notice.id) return { ...state, current: entry, leaving: false }
      if (state.queue.some(e => e.notice.id === entry.notice.id)) {
        return { ...state, queue: state.queue.map(e => (e.notice.id === entry.notice.id ? entry : e)) }
      }
      if (!state.current) return { ...state, current: entry, leaving: false }
      return { ...state, queue: [...state.queue, entry] }
    }
    case 'expire':
      return state.current ? { ...state, leaving: true } : state
    case 'next':
      return { current: state.queue[0] ?? null, queue: state.queue.slice(1), leaving: false }
  }
}

const ToastContext = createContext<{ show: (notice: ToastNotice) => void } | null>(null)

const noop = { show: () => {} }

/** `show(notice)` queues a toast. Outside a ToastProvider it does nothing. */
export function useToast(): { show: (notice: ToastNotice) => void } {
  return useContext(ToastContext) ?? noop
}

/**
 * One toast at a time; later toasts wait in a queue, and showing the id that is
 * already up replaces it. Each lasts `duration` (4s), paused while hovered or
 * focused. The region overlays the page: centred on the content column on
 * desktop (past the 224px sidebar), above the tab bar on phones.
 */
export function ToastProvider({ children, duration = TOAST_DURATION_MS }: { children: ReactNode, duration?: number }) {
  const [state, dispatch] = useReducer(reducer, { current: null, queue: [], leaving: false })
  // Paused for one toast only: the next one starts running even if the pointer never left.
  const [pausedKey, setPausedKey] = useState<number | null>(null)
  const counter = useRef(0)
  const remaining = useRef(duration)
  const shownKey = useRef<number | null>(null)

  const show = useCallback((notice: ToastNotice) => {
    counter.current += 1
    dispatch({ type: 'show', entry: { notice, key: counter.current } })
  }, [])

  const key = state.current?.key ?? null
  const paused = key !== null && pausedKey === key
  useEffect(() => {
    if (key === null) return
    if (state.leaving) {
      const t = setTimeout(() => dispatch({ type: 'next' }), TOAST_ANIMATION_MS)
      return () => clearTimeout(t)
    }
    if (shownKey.current !== key) {
      shownKey.current = key
      remaining.current = duration
    }
    if (paused) return
    const started = Date.now()
    const t = setTimeout(() => dispatch({ type: 'expire' }), remaining.current)
    return () => {
      clearTimeout(t)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
  }, [key, state.leaving, paused, duration])

  const value = useMemo(() => ({ show }), [show])
  const entry = state.current

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        data-testid="toast-region"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom,0px))] z-50 flex justify-center px-4 min-[900px]:bottom-6 min-[900px]:left-[224px]"
      >
        {entry && (
          <div
            key={entry.key}
            data-testid="toast"
            data-toast={entry.notice.id}
            data-leaving={state.leaving || undefined}
            onMouseEnter={() => setPausedKey(entry.key)}
            onMouseLeave={() => setPausedKey(null)}
            onFocus={() => setPausedKey(entry.key)}
            onBlur={() => setPausedKey(null)}
            tabIndex={-1}
            className={cn(
              'pointer-events-auto relative flex max-w-[440px] items-center gap-2.5 overflow-hidden rounded-[10px] border border-line-2 bg-active px-4 py-3 text-[14px] text-fg shadow-[var(--shadow-dialog)] outline-none',
              state.leaving ? 'sp-toast-out' : 'sp-toast-in',
            )}
          >
            <entry.notice.icon size={17} className={cn('shrink-0', NOTICE_TEXT[entry.notice.tone])} />
            <div className="min-w-0">
              <p>{entry.notice.title}</p>
              {entry.notice.detail && <p className="text-[13px] text-fg-2">{entry.notice.detail}</p>}
            </div>
            <span
              aria-hidden
              data-testid="toast-countdown"
              className={cn('sp-toast-countdown absolute inset-x-0 bottom-0 h-[2px] origin-left', NOTICE_BAR[entry.notice.tone])}
              style={{ animationDuration: `${duration}ms`, animationPlayState: paused || state.leaving ? 'paused' : 'running' }}
            />
          </div>
        )}
      </div>
    </ToastContext.Provider>
  )
}
