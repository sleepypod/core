'use client'

import { STAGE_COLORS } from '@/src/components/ds'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
export function modelScore(metrics: unknown) {
  const root = object(metrics)
  const evaluation = object(root.nestedSelection ?? root.lono)
  const rawKappa = number(evaluation.kappa)
  const kappa = rawKappa !== null && rawKappa >= -1 && rawKappa <= 1 ? rawKappa : null
  const rawBaseline = number(object(root.rules).kappa)
  const baseline = rawBaseline !== null && rawBaseline >= -1 && rawBaseline <= 1 ? rawBaseline : null
  const recall = object(evaluation.recall)
  const nights = number(evaluation.nights)
  return { kappa, baseline, recall, nights }
}
function agreement(kappa: number) {
  if (kappa < 0) return 'Below chance agreement'
  if (kappa <= 0.2) return 'Slight agreement'
  if (kappa <= 0.4) return 'Fair agreement'
  if (kappa <= 0.6) return 'Moderate agreement'
  if (kappa <= 0.8) return 'Substantial agreement'
  return 'Near-perfect agreement'
}

/** Descriptive held-out scores only: never substitute training fit or invented baseline values. */
export function ModelScorecard({ metrics }: { metrics: unknown }) {
  const { kappa, baseline, recall } = modelScore(metrics)
  const position = (value: number) => `${Math.max(0, Math.min(1, value)) * 100}%`
  return (
    <>
      <div className="grid gap-6 py-3 @min-[900px]:grid-cols-[minmax(140px,0.8fr)_minmax(260px,1.5fr)_minmax(220px,1fr)]">
        <div>
          <p className="mb-4 text-xs uppercase tracking-wider text-fg-3">κ vs Watch</p>
          <code className="font-mono text-5xl font-semibold" aria-label={kappa === null ? 'Kappa unavailable' : `κ ${kappa.toFixed(2)}`}>{kappa?.toFixed(2) ?? '—'}</code>
          <p className="mt-2 text-base">{kappa === null ? 'Not evaluated' : agreement(kappa)}</p>
          {baseline !== null && kappa !== null
            ? <p className="mt-1 text-sm text-fg-2">{`${kappa - baseline >= 0 ? '+' : ''}${(kappa - baseline).toFixed(2)} over rules (${baseline.toFixed(2)})`}</p>
            : <p className="mt-1 text-xs text-fg-3">Rules comparison not included in this model.</p>}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-fg-3">Scale</p>
          <div className="relative mt-4 h-14">
            {baseline !== null && <span className="absolute top-0 -translate-x-1/2 text-xs text-fg-2" style={{ left: position(baseline) }}>rules</span>}
            <div className="absolute inset-x-0 bottom-2 flex h-3 overflow-hidden rounded-full bg-active">
              {['slight', 'fair', 'moderate', 'substantial', 'near-perfect'].map(label => <span key={label} className="flex-1 border-r-2 border-surface last:border-0" />)}
            </div>
            {baseline !== null && <span className="absolute bottom-0 h-7 border-l-2 border-fg-3" style={{ left: position(baseline) }} />}
            {kappa !== null && (
              <span className="absolute bottom-0 h-7 border-l-2 border-fg" style={{ left: position(kappa) }}>
                <span className={`absolute -top-1 whitespace-nowrap rounded bg-surface px-1 text-xs text-fg ${kappa > 0.7 ? 'right-2' : 'left-2'}`}>This model</span>
              </span>
            )}
          </div>
          <div className="mt-3 flex justify-between gap-1 text-[10px] text-fg-3">
            <span>slight</span>
            <span>fair</span>
            <span>moderate</span>
            <span>substantial</span>
            <span>near-perfect</span>
          </div>
          <p className="mt-6 text-xs uppercase tracking-wider text-fg-3">Per night</p>
          <p className="mt-3 text-xs text-fg-2">Per-night scores are not included in this model export.</p>
        </div>
        <div>
          <p className="mb-4 text-xs uppercase tracking-wider text-fg-3">Matches Watch, by stage</p>
          {(['wake', 'light', 'deep', 'rem'] as const).map((stage) => {
            const raw = number(recall[stage])
            const value = raw !== null && raw >= 0 && raw <= 1 ? raw : null
            return (
              <div key={stage} className="mb-3 flex items-center gap-3 text-sm">
                <span className="w-10">{stage === 'rem' ? 'REM' : stage[0].toUpperCase() + stage.slice(1)}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-active"><span className="block h-full rounded-full" style={{ width: `${(value ?? 0) * 100}%`, background: STAGE_COLORS[stage === 'wake' ? 'awake' : stage] }} /></span>
                <span className="w-9 text-right font-mono text-fg-2">{value === null ? '—' : `${Math.round(value * 100)}%`}</span>
              </div>
            )
          })}
          <p className="text-xs text-fg-3">Share of Watch epochs in each stage the model labels the same. A dash means the export has no score.</p>
        </div>
      </div>
      <p className="text-xs text-fg-3">
        κ (kappa) measures agreement with Watch stages beyond chance: 0 is chance-level and 1 is perfect agreement. These descriptive bands are not a measure of clinical accuracy.
        {kappa !== null && ' Held-out nights were excluded from fitting the evaluated model.'}
      </p>
    </>
  )
}
