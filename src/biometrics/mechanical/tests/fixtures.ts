/** Synthetic telemetry for worker protocol tests, never hardware evidence. */
export function quietMechanicalSnapshot(now: number) {
  const epoch = 'd669e2b4-0b92-4c92-9110-17a840e66c11', span = '154d214f-c095-4aa0-80d5-dc97665b39df'
  const start = 1699999000000
  return { state: { version: 'mechanical-context-v1', epoch, publishedAtMs: now,
    confirmedThroughMs: now, validUntilMs: now + 10000, blockedUntilMs: 0,
    cleanSinceMs: start, spanId: span, reasons: [], commandAtMs: null, commandUntilMs: 0 },
  spans: [{ id: span, epoch, startMs: start, endMs: now }] }
}
