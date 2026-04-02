'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type Side = 'left' | 'right'
export type SideSelection = 'left' | 'right' | 'both'

interface SideContextValue {
  /** Currently selected side or both */
  selectedSide: SideSelection
  /** Whether both sides are linked (changes apply to both) */
  isLinked: boolean
  /** Select a specific side */
  selectSide: (side: SideSelection) => void
  /** Toggle linked mode — when linking, selects 'both'; when unlinking, falls back to 'left' */
  toggleLink: () => void
  /** The sides affected by the current selection */
  activeSides: Side[]
  /** The primary side used for display when both are selected */
  primarySide: Side
}

const SideContext = createContext<SideContextValue | null>(null)

const STORAGE_KEY_SIDE = 'sleepypod-selected-side'
const STORAGE_KEY_LINKED = 'sleepypod-is-linked'
const COOKIE_KEY_SIDE = 'sleepypod-side'
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 // 1 year in seconds

/** Read a cookie value by name */
function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

/** Set a cookie with SameSite=Lax and long expiry for cross-session persistence */
function setCookie(name: string, value: string) {
  if (typeof document === 'undefined') return
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`
}

export const SideProvider = ({ children }: { children: React.ReactNode }) => {
  const [selectedSide, setSelectedSide] = useState<SideSelection>('left')
  const [isLinked, setIsLinked] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  // Hydrate from localStorage (primary) or cookie (fallback) on mount
  useEffect(() => {
    try {
      const storedSide = localStorage.getItem(STORAGE_KEY_SIDE) as SideSelection | null
      const storedLinked = localStorage.getItem(STORAGE_KEY_LINKED)

      /* eslint-disable react-hooks/set-state-in-effect */
      if (storedSide && ['left', 'right', 'both'].includes(storedSide)) {
        setSelectedSide(storedSide)
      }
      else {
        // Fallback: try to restore from cookie
        const cookieSide = getCookie(COOKIE_KEY_SIDE) as SideSelection | null
        if (cookieSide && ['left', 'right', 'both'].includes(cookieSide)) {
          setSelectedSide(cookieSide)
        }
      }
      if (storedLinked !== null) {
        setIsLinked(storedLinked === 'true')
      }
      /* eslint-enable react-hooks/set-state-in-effect */
    }
    catch {
      // localStorage unavailable (SSR or privacy mode) — try cookie only
      const cookieSide = getCookie(COOKIE_KEY_SIDE) as SideSelection | null
      if (cookieSide && ['left', 'right', 'both'].includes(cookieSide)) {
        setSelectedSide(cookieSide)
      }
    }
    setHydrated(true)
  }, [])

  // Persist to localStorage AND cookie on change (after hydration)
  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(STORAGE_KEY_SIDE, selectedSide)
      localStorage.setItem(STORAGE_KEY_LINKED, String(isLinked))
    }
    catch {
      // localStorage unavailable
    }
    // Always persist to cookie as a durable fallback
    setCookie(COOKIE_KEY_SIDE, selectedSide)
  }, [selectedSide, isLinked, hydrated])

  const selectSide = useCallback((side: SideSelection) => {
    setSelectedSide(side)
    // If selecting a specific side while linked, unlink
    if (side !== 'both') {
      setIsLinked(false)
    }
  }, [])

  const toggleLink = useCallback(() => {
    setIsLinked((prev) => {
      const next = !prev
      if (next) {
        setSelectedSide('both')
      }
      else {
        // Fall back to left side when unlinking (matches iOS behavior)
        setSelectedSide('left')
      }
      return next
    })
  }, [])

  const activeSides: Side[]
    = selectedSide === 'both'
      ? ['left', 'right']
      : [selectedSide]

  const primarySide: Side
    = selectedSide === 'right' ? 'right' : 'left'

  return (
    <SideContext.Provider
      value={{
        selectedSide,
        isLinked,
        selectSide,
        toggleLink,
        activeSides,
        primarySide,
      }}
    >
      {/* Suppress side-dependent UI flash during hydration */}
      {hydrated
        ? children
        : (
            <div style={{ visibility: 'hidden' }}>{children}</div>
          )}
    </SideContext.Provider>
  )
}

export const useSide = () => {
  const ctx = useContext(SideContext)
  if (!ctx) {
    throw new Error('useSide must be used within a SideProvider')
  }
  return ctx
}
