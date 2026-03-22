'use client'

export default function SensorsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-4">
      <p className="text-sm text-red-400">Sensors crashed</p>
      <p className="text-xs text-zinc-500">
        Something went wrong loading sensor data.
        {error.digest && <span className="ml-1 text-zinc-600">({error.digest})</span>}
      </p>
      <button
        onClick={reset}
        className="rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 active:bg-zinc-700"
      >
        Retry
      </button>
    </div>
  )
}
