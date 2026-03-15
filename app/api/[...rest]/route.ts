import { appRouter } from '@/src/server/routers/app'
import { createOpenApiFetchHandler } from 'trpc-to-openapi'

const handler = (req: Request) =>
  createOpenApiFetchHandler({
    endpoint: '/api',
    req,
    router: appRouter,
    createContext: () => ({}),
  })

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE }
