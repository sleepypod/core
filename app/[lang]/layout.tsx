import '@/app/globals.css'
import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import dynamic from 'next/dynamic'
import Script from 'next/script'
import { AppShell } from '@/src/components/AppShell/AppShell'
import { allMessages, getI18nInstance } from '@/src/lib/i18n/appRouterI18n'
import { LinguiClientProvider } from '@/src/providers/LinguiClientProvider'
import { PrefsProvider, THEME_INIT_SCRIPT } from '@/src/providers/PrefsProvider'
import { SideProvider } from '@/src/providers/SideProvider'
import { TRPCProvider } from '@/src/providers/TRPCProvider'
import { WeekNavigatorProvider } from '@/src/providers/WeekNavigatorProvider'
import { setI18n } from '@lingui/react/server'

// Self-hosted at build time by next/font, so the pod serves them offline.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
})
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
})

// Hosted demo only; pods are LAN-only and must not phone home. Gated on the
// build-time flag so pod builds drop the analytics bundle entirely.
const DemoAnalytics = process.env.NEXT_PUBLIC_DEMO === '1'
  ? dynamic(() => import('@vercel/analytics/next').then(m => m.Analytics))
  : () => null

// Locales inlined to avoid importing lingui.config.ts at SSG time.
// Turbopack's module resolution fails for this import on cross-platform deploys.
const LOCALES = ['en', 'es', 'pseudo']

export const dynamicParams = false

export const metadata: Metadata = {
  title: { template: '%s · sleepypod', default: 'sleepypod' },
}

export function generateStaticParams() {
  return LOCALES.map(lang => ({ lang }))
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
    <html lang={lang} className={`dark ${plexSans.variable} ${plexMono.variable}`} data-theme="dark" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
        <meta name="theme-color" content="#0b0b0c" />
        <meta name="color-scheme" content="dark light" />
        <link rel="icon" type="image/png" href="/icon.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <Script id="sp-theme-init" strategy="beforeInteractive">{THEME_INIT_SCRIPT}</Script>
      </head>
      <body>
        <TRPCProvider>
          <LinguiClientProvider initialLocale={lang} initialMessages={allMessages[lang]}>
            <PrefsProvider>
              <SideProvider>
                <WeekNavigatorProvider>
                  <AppShell>{children}</AppShell>
                </WeekNavigatorProvider>
              </SideProvider>
            </PrefsProvider>
          </LinguiClientProvider>
        </TRPCProvider>
        <DemoAnalytics />
      </body>
    </html>
  )
}
