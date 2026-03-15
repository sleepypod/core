import { appRouter } from '@/src/server/routers/app'
import { renderTrpcPanel } from '@ajayche/trpc-panel'

export function GET(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return new Response('Not Found', { status: 404 })
  }

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
