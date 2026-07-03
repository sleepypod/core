import { appRouter } from '@/src/server/routers/app'
import { renderTrpcPanel } from '@ajayche/trpc-panel'

export function GET(req: Request) {
  // Dev tool only: the panel exposes every procedure (device.execute,
  // system.setInternetAccess, raw.deleteFile, ...) with zero gating, and the
  // API itself is unauthenticated (LAN-only trust model — see
  // src/server/openapi.ts). Don't serve it from production pods.
  if (process.env.NODE_ENV === 'production') {
    return new Response('Not found', { status: 404 })
  }

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
