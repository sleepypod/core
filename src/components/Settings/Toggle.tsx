'use client'

interface ToggleProps {
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
  label?: string
}

/**
 * Reusable toggle switch matching existing app patterns.
 */
export function Toggle({ enabled, onToggle, disabled = false, label }: ToggleProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`relative flex min-h-[44px] min-w-[48px] items-center justify-center disabled:opacity-50`}
      aria-label={label}
      role="switch"
      aria-checked={enabled}
    >
      {/* Visual toggle track */}
      <span className={`relative h-7 w-12 rounded-full transition-colors ${enabled ? 'bg-sky-500' : 'bg-zinc-700'}`}>
        <span
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  )
}
