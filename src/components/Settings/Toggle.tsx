'use client'

interface ToggleProps {
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
  label?: string
}

/**
 * Reusable toggle switch.
 */
export function Toggle({ enabled, onToggle, disabled = false, label }: ToggleProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className="shrink-0 disabled:opacity-50"
      aria-label={label}
      role="switch"
      aria-checked={enabled}
    >
      <span
        className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
          enabled ? 'bg-sky-500' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </span>
    </button>
  )
}
