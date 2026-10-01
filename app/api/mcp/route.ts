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

async function handler(req: Request): Promise<Response> {
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
    void transport.close()
  }
}

export { handler as GET, handler as POST, handler as DELETE }
