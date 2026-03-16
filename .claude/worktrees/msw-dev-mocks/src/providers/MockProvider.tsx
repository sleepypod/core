'use client'

import { useEffect } from 'react'

export function MockProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
      import('@/src/mocks/browser')
        .then(({ worker }) => worker.start({ onUnhandledRequest: 'bypass' }))
        .catch(console.error)
    }
  }, [])
  return <>{children}</>
}
