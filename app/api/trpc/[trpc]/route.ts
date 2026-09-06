import { appRouter } from '@/src/server/routers/app'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

const handler = (req: Request) => {
  if (process.env.NODE_ENV !== 'production') console.log('tRPC incoming:', req.url)
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => ({}),
  })
}

export { handler as GET, handler as POST }
