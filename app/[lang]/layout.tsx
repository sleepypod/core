import '@/app/globals.css'
import { BottomNav } from '@/src/components/BottomNav/BottomNav'
import { Header } from '@/src/components/Header/Header'
import { SwipeContainer } from '@/src/components/SwipeContainer/SwipeContainer'
import { allMessages, getI18nInstance } from '@/src/lib/i18n/appRouterI18n'
import { LinguiClientProvider } from '@/src/providers/LinguiClientProvider'
import { SideProvider } from '@/src/providers/SideProvider'
import { TRPCProvider } from '@/src/providers/TRPCProvider'
import { setI18n } from '@lingui/react/server'
import linguiConfig from 'lingui.config'

export const dynamicParams = false

export function generateStaticParams() {
  return linguiConfig.locales.map((lang: string) => ({ lang }))
}

export default async function LangLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ lang: string }>
}) {
  const { lang } = await params

  const i18n = getI18nInstance(lang)
  setI18n(i18n)

  return (
    <html lang={lang} className="dark">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="theme-color" content="#0a0a0a" />
        <meta name="color-scheme" content="dark" />
      </head>
      <body>
        <TRPCProvider>
          <LinguiClientProvider initialLocale={lang} initialMessages={allMessages[lang]}>
            <SideProvider>
              <div className="flex min-h-dvh flex-col items-center bg-black pb-20 text-white sm:pb-24">
                <Header />

                <div className="w-full max-w-md space-y-4 px-3 pt-3 sm:space-y-6 sm:px-4 sm:pt-4">
                  <SwipeContainer>
                    {children}
                  </SwipeContainer>

                  <BottomNav />
                </div>
              </div>
            </SideProvider>
          </LinguiClientProvider>
        </TRPCProvider>
      </body>
    </html>
  )
}
