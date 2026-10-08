'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'

export type ControlVariant = 'dial' | 'slider' | 'stepper'
export type ThemePref = 'auto' | 'dark' | 'light'
/**
 * Degrees; the ± offset from 80°F (0) that the old dial uses; or the Eight
 * Sleep −10…+10 level (0 = 82.5°F, 2.75°F a step).
 */
export type TempDisplay = 'degrees' | 'offset' | 'level'

interface PrefsContextValue {
  /** Temperature control variant on the Temp screen. Stored per device. */
  control: ControlVariant
  setControl: (v: ControlVariant) => void
  /** How the Temp screen's big number reads. Stored per device. */
  tempDisplay: TempDisplay
  setTempDisplay: (v: TempDisplay) => void
  /** Theme preference. 'auto' follows prefers-color-scheme. */
  theme: ThemePref
  setTheme: (v: ThemePref) => void
  /** The theme actually applied after resolving 'auto'. */
  resolvedTheme: 'dark' | 'light'
}

export const PREFS_STORAGE_KEYS = {
  control: 'sleepypod-pref-control',
  tempDisplay: 'sleepypod-pref-temp-display',
  theme: 'sleepypod-pref-theme',
} as const

const PrefsContext = createContext<PrefsContextValue | null>(null)

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  }
  catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  }
  catch {
    // storage unavailable (private mode) — the preference just won't persist
  }
}

function systemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyTheme(resolved: 'dark' | 'light') {
  const root = document.documentElement
  root.dataset.theme = resolved
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f6f6f5' : '#0b0b0c')
}

/**
 * Inline script run in <head> before first paint so the stored theme applies
 * without a dark→light flash. Mirrors applyTheme().
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${PREFS_STORAGE_KEYS.theme}')||'auto';var r=t==='auto'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):t;var d=document.documentElement;d.dataset.theme=r;d.classList.toggle('dark',r==='dark');d.style.colorScheme=r;}catch(e){}})();`

const PREFS_EVENT = 'sleepypod-prefs-change'

function subscribeStorage(cb: () => void) {
  window.addEventListener('storage', cb)
  window.addEventListener(PREFS_EVENT, cb)
  return () => {
    window.removeEventListener('storage', cb)
    window.removeEventListener(PREFS_EVENT, cb)
  }
}

function subscribeScheme(cb: () => void) {
  const mq = window.matchMedia?.('(prefers-color-scheme: light)')
  mq?.addEventListener('change', cb)
  return () => mq?.removeEventListener('change', cb)
}

function useStoredPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = useSyncExternalStore(subscribeStorage, () => read(key), () => null)
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

function store(key: string, value: string) {
  write(key, value)
  window.dispatchEvent(new Event(PREFS_EVENT))
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const control = useStoredPref<ControlVariant>(PREFS_STORAGE_KEYS.control, ['dial', 'slider', 'stepper'], 'dial')
  const tempDisplay = useStoredPref<TempDisplay>(PREFS_STORAGE_KEYS.tempDisplay, ['degrees', 'offset', 'level'], 'degrees')
  const theme = useStoredPref<ThemePref>(PREFS_STORAGE_KEYS.theme, ['auto', 'dark', 'light'], 'auto')
  const system = useSyncExternalStore(subscribeScheme, systemTheme, () => 'dark' as const)

  const resolvedTheme = theme === 'auto' ? system : theme

  useEffect(() => {
    applyTheme(resolvedTheme)
  }, [resolvedTheme])

  const setControl = useCallback((v: ControlVariant) => store(PREFS_STORAGE_KEYS.control, v), [])
  const setTempDisplay = useCallback((v: TempDisplay) => store(PREFS_STORAGE_KEYS.tempDisplay, v), [])
  const setTheme = useCallback((v: ThemePref) => store(PREFS_STORAGE_KEYS.theme, v), [])

  const value = useMemo(
    () => ({ control, setControl, tempDisplay, setTempDisplay, theme, setTheme, resolvedTheme }),
    [control, setControl, tempDisplay, setTempDisplay, theme, setTheme, resolvedTheme],
  )

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
}

export function usePrefs(): PrefsContextValue {
  const ctx = useContext(PrefsContext)
  if (!ctx) throw new Error('usePrefs must be used within PrefsProvider')
  return ctx
}
