import { appRouter } from '@/src/server/routers/app'
import { renderTrpcPanel } from '@ajayche/trpc-panel'

export function GET(req: Request) {
  const host = req.headers.get('host') || new URL(req.url).host
  const proto = req.headers.get('x-forwarded-proto') || 'http'

  return new Response(
    renderTrpcPanel(appRouter, {
      url: `${proto}://${host}/api/trpc`,
      transformer: 'superjson',
      meta: { title: 'sleepypod API Explorer' },
    }),
    {
      headers: { 'content-type': 'text/html' },
    },
  )
}
