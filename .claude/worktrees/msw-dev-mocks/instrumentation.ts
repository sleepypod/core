/**
 * Next.js instrumentation hook.
 * Delegates Node.js-specific startup to instrumentation.node.ts
 * to avoid Edge Runtime compatibility errors.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startNodeServer } = await import('./instrumentation.node')
    await startNodeServer()
  }
}
