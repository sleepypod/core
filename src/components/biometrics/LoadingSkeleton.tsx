'use client'

/**
 * Loading skeleton for the biometrics screen.
 * Matches the card layout with subtle pulse animation.
 */
export function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      {/* Week navigator skeleton */}
      <div className="flex items-center justify-between py-2">
        <div className="h-10 w-10 rounded-full bg-zinc-800" />
        <div className="h-4 w-32 rounded bg-zinc-800" />
        <div className="h-10 w-10 rounded-full bg-zinc-800" />
      </div>

      {/* Side pill skeleton */}
      <div className="flex justify-center">
        <div className="h-8 w-36 rounded-full bg-zinc-800" />
      </div>

      {/* Summary card skeleton */}
      <div className="h-32 rounded-2xl bg-zinc-900/80" />

      {/* Stages timeline skeleton */}
      <div className="h-64 rounded-2xl bg-zinc-900/80" />

      {/* Vitals grid skeleton */}
      <div className="grid grid-cols-3 gap-2">
        <div className="h-20 rounded-xl bg-zinc-900/80" />
        <div className="h-20 rounded-xl bg-zinc-900/80" />
        <div className="h-20 rounded-xl bg-zinc-900/80" />
      </div>

      {/* Chart skeletons */}
      <div className="h-48 rounded-2xl bg-zinc-900/80" />
      <div className="h-48 rounded-2xl bg-zinc-900/80" />
      <div className="h-48 rounded-2xl bg-zinc-900/80" />

      {/* Weekly chart skeleton */}
      <div className="h-40 rounded-2xl bg-zinc-900/80" />
    </div>
  )
}
