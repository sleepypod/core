/**
 * In-process tRPC caller used by every MCP tool.
 *
 * Tools never duplicate router logic: they call the same procedures the web
 * UI and REST layer use, so validation, side locks, pump-stall guards and
 * mutation broadcasts all apply unchanged.
 */
import { TRPCError } from '@trpc/server'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { appRouter } from '@/src/server/routers/app'

export type Caller = ReturnType<typeof appRouter.createCaller>

let cached: Caller | undefined

export function getCaller(): Caller {
  cached ??= appRouter.createCaller({})
  return cached
}

/** Serialize a procedure result as a JSON text block. Dates become ISO strings. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function describeError(error: unknown): string {
  // Internal errors wrap database/transport failures; the full error is logged
  // server-side so the model only needs to know the call did not succeed.
  if (error instanceof TRPCError && error.code === 'INTERNAL_SERVER_ERROR') return 'INTERNAL_SERVER_ERROR: the pod could not complete the request'
  if (error instanceof TRPCError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Run a tool body and convert thrown errors into an `isError` result so the
 * model sees the reason (validation message, pump-stall block, hardware
 * timeout) instead of a bare JSON-RPC failure.
 */
export async function runTool(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body()
  }
  catch (error) {
    console.error('[mcp] tool failed:', error)
    return { isError: true, content: [{ type: 'text', text: describeError(error) }] }
  }
}
