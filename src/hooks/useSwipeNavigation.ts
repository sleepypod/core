'use client'

import { useCallback, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'

/** Ordered screen routes for swipe navigation. */
const SCREEN_ORDER = ['/', '/schedule', '/data', '/sensors', '/status', '/settings']

/** Minimum horizontal swipe distance in px to trigger navigation. */
const SWIPE_THRESHOLD = 60

/** Maximum vertical movement allowed — prevents hijacking vertical scroll. */
const VERTICAL_LIMIT = 80

interface SwipeState {
  startX: number
  startY: number
  startTime: number
}

/**
 * Hook that provides horizontal swipe navigation between the 5 main screens.
 * Returns touch event handlers to attach to the swipeable container.
 *
 * Swipe right → previous screen, swipe left → next screen.
 * Only triggers if the swipe is predominantly horizontal and exceeds threshold.
 */
export function useSwipeNavigation() {
  const router = useRouter()
  const pathname = usePathname()
  const swipeRef = useRef<SwipeState | null>(null)
  const isNavigatingRef = useRef(false)

  // Extract path without lang prefix
  const getBasePath = useCallback(() => {
    if (!pathname) return '/'
    const segments = pathname.split('/')
    const pathWithoutLang = '/' + segments.slice(2).join('/')
    return pathWithoutLang === '' ? '/' : pathWithoutLang
  }, [pathname])

  const getLang = useCallback(() => {
    return pathname?.split('/')[1] ?? 'en'
  }, [pathname])

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Only track single-finger swipes
    if (e.touches.length !== 1) return

    const touch = e.touches[0]
    swipeRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
    }
  }, [])

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    const state = swipeRef.current
    if (!state || isNavigatingRef.current) {
      swipeRef.current = null
      return
    }

    const touch = e.changedTouches[0]
    const deltaX = touch.clientX - state.startX
    const deltaY = Math.abs(touch.clientY - state.startY)
    const elapsed = Date.now() - state.startTime

    swipeRef.current = null

    // Reject if too vertical (scrolling), too slow, or too short
    if (deltaY > VERTICAL_LIMIT) return
    if (elapsed > 500) return
    if (Math.abs(deltaX) < SWIPE_THRESHOLD) return

    // Don't intercept swipes that started inside horizontally scrollable elements
    const target = e.target as HTMLElement
    if (target.closest('[data-no-swipe], [style*="overflow-x"], .overflow-x-auto, .overflow-x-scroll')) return

    const basePath = getBasePath()
    const currentIndex = SCREEN_ORDER.findIndex(
      p => basePath === p || (p !== '/' && basePath.startsWith(p))
    )
    if (currentIndex === -1) return

    const direction = deltaX > 0 ? -1 : 1 // swipe right = prev, swipe left = next
    const nextIndex = currentIndex + direction

    if (nextIndex < 0 || nextIndex >= SCREEN_ORDER.length) return

    const lang = getLang()
    const nextPath = SCREEN_ORDER[nextIndex]

    isNavigatingRef.current = true
    router.push(`/${lang}${nextPath}`)

    // Reset navigation lock after transition
    setTimeout(() => {
      isNavigatingRef.current = false
    }, 400)
  }, [getBasePath, getLang, router])

  return {
    onTouchStart,
    onTouchEnd,
  }
}
