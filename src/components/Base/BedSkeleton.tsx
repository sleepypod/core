/** A soft bed silhouette drawn in the room while three.js loads; the canvas fades in over it. */
export function BedSkeleton({ label, className = 'inset-x-3 top-1 bottom-8 rounded-2xl' }: { label: string, className?: string }) {
  return (
    <div role="status" aria-label={label} className={`pointer-events-none absolute overflow-hidden ${className}`}>
      <div className="absolute inset-0 grid place-items-center">
        <div className="relative aspect-[5.7/4.4] w-[46%] animate-pulse" style={{ transform: 'rotateX(55deg) rotateZ(-20deg)' }}>
          <div className="absolute inset-0 rounded-[18%] bg-fg/10" />
          <div className="absolute inset-x-[7%] inset-y-[6%] grid grid-cols-2 gap-[3%]">
            <div className="rounded-[14%] bg-fg/15" />
            <div className="rounded-[14%] bg-fg/15" />
          </div>
        </div>
      </div>
      <span className="absolute inset-x-0 bottom-3 text-center text-[11px] uppercase tracking-[0.15em] text-fg-3">{label}</span>
    </div>
  )
}
