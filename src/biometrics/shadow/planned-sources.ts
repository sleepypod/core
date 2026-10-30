import { dataHash } from '../algorithms/canonical'
import { shadowPlanSchema } from './store'
import { openShadowActiveDatabase } from './active-database'
import { ShadowContextReader } from './context'
import { openShadowLiveSources } from './live-sources'
import { readMechanicalSnapshot } from '../mechanical/snapshot'
import type { ShadowAttemptHost, ShadowSources } from './attempt'

/** Trusted installation paths only. This factory owns its read-only connections
 * and closes them after unsubscribing on every failure/cancellation/finish path.
 * Admission and worker launch remain the attempt controller's responsibility. */
export function plannedShadowSourceFactory(rawPlan: unknown, locations: {
  biometricsDatabase: string
  configurationDatabase: string
  presenceFile: string
}): ShadowAttemptHost['openSources'] {
  const plan = shadowPlanSchema.parse(structuredClone(rawPlan))
  if (!plan.execution || !plan.joining) throw new Error('Planned shadow sources require execution and joining policies')
  const execution = structuredClone(plan.execution), joining = { ...plan.joining }, paths = { ...locations }
  const executionHash = dataHash(execution)
  return (input) => {
    if (dataHash(input.execution) !== executionHash || input.collectionEndsAtMs !== plan.endMs) throw new Error('Shadow source policy differs from saved plan')
    if (input.signal.aborted) throw new Error('Shadow sources cancelled before opening')
    let biometrics: ReturnType<typeof openShadowActiveDatabase> | undefined
    let configuration: ReturnType<typeof openShadowActiveDatabase> | undefined
    let live: ShadowSources | undefined, closed = false
    const close = () => {
      if (closed) return
      closed = true
      input.signal.removeEventListener('abort', close)
      try {
        live?.close()
      }
      finally {
        try {
          configuration?.close()
        }
        finally { biometrics?.close() }
      }
    }
    try {
      const databaseOptions = { busyTimeoutMs: execution.sources.databaseBusyTimeoutMs }
      biometrics = openShadowActiveDatabase(paths.biometricsDatabase, databaseOptions)
      configuration = openShadowActiveDatabase(paths.configurationDatabase, databaseOptions)
      const bio = biometrics, config = configuration
      const assertCurrent = () => {
        bio.assertCurrent()
        config.assertCurrent()
      }
      const context = new ShadowContextReader(config.db, paths.presenceFile, execution.sources.context, assertCurrent)
      live = openShadowLiveSources({ db: bio.db, side: plan.side, startMs: plan.startMs, endMs: plan.endMs,
        activeConfigHash: plan.activeConfigHash, maximumActiveRows: execution.sources.maximumActiveRows,
        maximumLatenessMs: joining.maximumLatenessMs, pollMs: execution.sources.pollMs,
        frameBudgets: execution.sources.frames, context: (frame, at) => ({ ...context.snapshot(frame, at), mechanical: readMechanicalSnapshot(bio.db, at) }),
        assertDatabaseCurrent: assertCurrent, signal: input.signal, active: input.active,
        fail: () => {
          try {
            close()
          }
          finally { input.fail() }
        } })
      input.signal.addEventListener('abort', close, { once: true })
      if (input.signal.aborted) {
        close()
        throw new Error('Shadow sources cancelled while opening')
      }
      const source = live
      return { frames: source.frames, flush: () => {
        if (closed) throw new Error('Planned shadow sources are closed')
        try {
          source.flush?.()
        }
        catch (error) {
          close()
          throw error
        }
      }, close }
    }
    catch (error) {
      close()
      throw error
    }
  }
}
