import { requireAccess } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'
import { appRouter } from '@/src/server/routers/app'
import { createOpenApiFetchHandler } from 'trpc-to-openapi'

const handler = async (req: Request) => {
  const denied = requireAccess(req)
  if (denied) return denied
  return privateApiResponse(req, await createOpenApiFetchHandler({
    endpoint: '/api',
    req,
    router: appRouter,
    createContext: () => ({}),
  }))
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE }
