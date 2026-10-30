/** Numeric automation inputs must remain finite through conversion and arithmetic. */
export function finiteSignal(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
