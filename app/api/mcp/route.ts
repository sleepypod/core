/**
 * MCP endpoint (Streamable HTTP, stateless).
 *
 * Each request builds a fresh McpServer + transport pair, so no session state
 * lives in the Next.js process and horizontal scaling or restarts are safe.
 * Like the rest of the API this trusts the LAN: do not expose it to the WAN.
 *
 * Client setup:
 *   claude mcp add --transport http sleepypod http://<pod-ip>:3000/api/mcp
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createSleepypodMcpServer } from '@/src/mcp/server'

export const dynamic = 'force-dynamic'

/**
 * Browsers always attach an Origin header to cross-site requests, so a
 * DNS-rebinding page cannot reach this endpoint if a present Origin must
 * match the Host it was sent to. Native MCP clients send no Origin and pass.
 */
export function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (origin === null) return true
  try {
    return new URL(origin).host === req.headers.get('host')
  }
  catch {
    return false
  }
}

async function handler(req: Request): Promise<Response> {
  if (!isOriginAllowed(req)) {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden: cross-origin request' }, id: null },
      { status: 403 },
    )
  }
  const server = createSleepypodMcpServer()
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(req)
  }
  finally {
    // The response body is already materialized in JSON mode, so closing here
    // cannot truncate it. Closing releases the transport/server pair.
    transport.close().catch((err: unknown) => console.warn('[mcp] transport close failed:', err))
  }
}

export { handler as GET, handler as POST, handler as DELETE }
