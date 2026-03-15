import { appRouter } from '@/src/server/routers/app'
import { renderTrpcPanel } from '@ajayche/trpc-panel'

export function GET(req: Request) {
  const { origin } = new URL(req.url)

  return new Response(
    renderTrpcPanel(appRouter, {
      url: `${origin}/api/trpc`,
      meta: { title: 'sleepypod API Explorer' },
    }),
    {
      headers: { 'content-type': 'text/html' },
    },
  )
}
