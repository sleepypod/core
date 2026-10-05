import type { Metadata } from 'next'
import { BasePage } from '@/src/components/Base/BasePage'
import { TRPCProvider } from '@/src/providers/TRPCProvider'

export const metadata: Metadata = { title: 'Adjustable base' }
export default async function Base({ params, searchParams }: {
  params: Promise<{ lang: string }>
  searchParams: Promise<{ debug?: string | string[] }>
}) {
  const [{ lang }, query] = await Promise.all([params, searchParams])
  if (query.debug !== '1') return <BasePage />
  return (
    <TRPCProvider key="base-debug" baseDebug>
      <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn-line bg-warn-bg p-4 text-sm text-warn">
        <span>Base debug · Simulated movement and schedules. No base commands are sent to hardware.</span>
        <a href={`/${lang}/base`} className="underline">Exit debug</a>
      </div>
      <BasePage />
    </TRPCProvider>
  )
}
