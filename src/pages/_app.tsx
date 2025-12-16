import { I18nProvider } from '@lingui/react'
import { i18n } from '@lingui/core'
import type { AppType } from 'next/app'
import { trpc } from '../utils/trpc'

// Initialize i18n
i18n.loadAndActivate({ locale: 'en', messages: {} })

const MyApp: AppType = ({ Component, pageProps }) => {
  return (
    <I18nProvider i18n={i18n}>
      <Component {...pageProps} />
    </I18nProvider>
  )
}

export default trpc.withTRPC(MyApp)
