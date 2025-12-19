import { BottomNav } from '@/components/BottomNav/BottomNav';
import { TRPCProvider } from '@/src/components/providers/TRPCProvider';
import type { Metadata } from 'next';
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});


export const metadata: Metadata = {
  title: 'sleepypod',
}

// This layout does not rely on the `lang` param
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html className={inter.variable}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>

      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* TRPCProvider should be placed here (high up) to maintain its state/cache
            across locale changes (e.g., /en/page -> /ar/page) */}
        <TRPCProvider>
          <div className="min-h-screen bg-black text-white flex flex-col items-center pb-24">
            <div className="w-full max-w-md px-4 pt-4 space-y-6">
              {children}

              <BottomNav />
            </div>
          </div>
        </TRPCProvider>
      </body>
    </html >
  )
}
