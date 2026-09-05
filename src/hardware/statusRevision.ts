/** Shared across Next.js bundles so every hardware writer invalidates cached reads. */
const g = globalThis as Record<string, unknown>
const KEY = '__sp_status_revision__'

function state(): { revision: number, pending: number } {
  return (g[KEY] ??= { revision: 0, pending: 0 }) as { revision: number, pending: number }
}

/** A null revision means a write is queued or running: no snapshot is reusable. */
export function getStatusRevision(): number | null {
  const s = state()
  return s.pending === 0 ? s.revision : null
}

/** Invalidate before and after a write, including failed/partially applied writes. */
export function beginStatusChange(): () => void {
  const s = state()
  s.pending++
  s.revision++
  return () => {
    s.pending--
    s.revision++
  }
}
