import '@/app/globals.css'
import { BottomNav } from '@/src/components/BottomNav/BottomNav'
import { LinguiClientProvider } from '@/src/components/providers/LinguiClientProvider'
import { TRPCProvider } from '@/src/components/providers/TRPCProvider'
import { allMessages, getI18nInstance } from '@/src/lib/i18n/appRouterI18n'
import { setI18n } from '@lingui/react/server'

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
    <html lang={lang}>
      <body>
        <TRPCProvider>
          <LinguiClientProvider initialLocale={lang} initialMessages={allMessages[lang]}>
            <div className="flex min-h-screen flex-col items-center bg-black pb-24 text-white">
              <div className="w-full max-w-md space-y-6 px-4 pt-4">
                {children}
                <BottomNav />
              </div>
            </div>
          </LinguiClientProvider>
        </TRPCProvider>
      </body>
    </html>
  )
}
