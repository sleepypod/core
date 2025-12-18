import { TRPCProvider } from '@/src/components/providers/TRPCProvider' // Our client component TRPC wrapper
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'MyApp',
  description: 'Global description',
}

// This layout does not rely on the `lang` param
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>

      <body>
        {/* TRPCProvider should be placed here (high up) to maintain its state/cache
            across locale changes (e.g., /en/page -> /ar/page) */}
        <TRPCProvider>
          {children}
        </TRPCProvider>
      </body>
    </html>
  )
}
