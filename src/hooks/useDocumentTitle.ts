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
  }, [title])
}
