'use client'

interface QualityScoreProps {
  score: number // 0-100
}

function getScoreColor(score: number): string {
  if (score >= 80) return '#22c55e' // green
  if (score >= 60) return '#38bdf8' // sky/accent
  if (score >= 40) return '#f59e0b' // amber
  return '#ef4444' // red
}

function getScoreLabel(score: number): string {
  if (score >= 80) return 'Excellent'
  if (score >= 60) return 'Good'
  if (score >= 40) return 'Fair'
  return 'Poor'
}

/**
 * Circular quality score indicator matching iOS SleepStagesTimelineView.
 * Shows score number inside a ring with color-coded quality level.
 */
export function QualityScore({ score }: QualityScoreProps) {
  const color = getScoreColor(score)
  const label = getScoreLabel(score)

  // SVG arc for the ring
  const size = 72
  const strokeWidth = 5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const progress = (score / 100) * circumference
  const offset = circumference - progress

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} className="-rotate-90">
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#27272a"
          strokeWidth={strokeWidth}
        />
        {/* Progress ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-700 ease-out"
        />
        {/* Score text — rotate back to be upright */}
        <text
          x={size / 2}
          y={size / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize="18"
          fontWeight="600"
          transform={`rotate(90, ${size / 2}, ${size / 2})`}
        >
          {score}
        </text>
      </svg>
      <span className="text-[11px] font-medium" style={{ color }}>
        {label}
      </span>
    </div>
  )
}
