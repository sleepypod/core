'use client'

import { type Messages, setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { useState } from 'react'

interface LinguiClientProviderProps {
  children: React.ReactNode
  initialLocale: string
  initialMessages: Messages
}

export const LinguiClientProvider = ({
  children,
  initialLocale,
  initialMessages,
}: LinguiClientProviderProps) => {
  const [i18n] = useState(() => {
    const inst = setupI18n({
      locale: initialLocale,
      messages: { [initialLocale]: initialMessages },
    })
    try {
      inst.activate(initialLocale)
    }
    catch (err) {
      console.error('Error activating i18n instance:', err)
    }
    return inst
  })

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>
}
