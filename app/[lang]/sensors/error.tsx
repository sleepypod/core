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
      <pre className="max-w-full overflow-auto rounded-lg bg-zinc-900 p-3 text-[10px] text-zinc-400">
        {error.message}
      </pre>
      <button
        onClick={reset}
        className="rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 active:bg-zinc-700"
      >
        Retry
      </button>
    </div>
  )
}
