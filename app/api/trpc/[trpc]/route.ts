import { requireAccess } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'
import { appRouter } from '@/src/server/routers/app'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

const handler = async (req: Request) => {
  const denied = requireAccess(req)
  if (denied) return denied
  return privateApiResponse(req, await fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => ({}),
  }))
}

export { handler as GET, handler as POST }
