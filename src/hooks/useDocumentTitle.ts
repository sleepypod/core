'use client'

import { useEffect } from 'react'

export const APP_TITLE = 'sleepypod'

/**
 * Title for a sub-page picked by a query param ("Health · System · sleepypod").
 * Route metadata can't see search params on these statically generated pages,
 * so screens with sub-pages set the tab title themselves.
 */
export function useDocumentTitle(...parts: Array<string | null | undefined | false>) {
  const title = [...parts.filter(Boolean), APP_TITLE].join(' · ')
  useEffect(() => {
    document.title = title
    // Next applies the route's metadata title after hydration, which can land
    // after this effect; keep ours while the screen is mounted.
    const observer = new MutationObserver(() => {
      if (document.title !== title) document.title = title
    })
    observer.observe(document.head, { subtree: true, childList: true, characterData: true })
    return () => observer.disconnect()
  }, [title])
}
