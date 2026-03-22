'use client'

import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  MinusCircle,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import clsx from 'clsx'

// ─── Types ────────────────────────────────────────────────────────────

type ServiceStatus = 'ok' | 'degraded' | 'error' | 'unknown'

interface ServiceItem {
  name: string
  description?: string
  status: ServiceStatus
  detail?: string
}

interface HealthStatusCardProps {
  /** Category title */
  title: string
  /** Short subtitle */
  description: string
  /** Lucide icon component */
  icon: LucideIcon
  /** Accent color for the icon (Tailwind text color class) */
  iconColor: string
  /** Background tint for the icon (Tailwind bg color class) */
  iconBg: string
  /** Individual services/checks in this category */
  services: ServiceItem[]
  /** Whether data is loading */
  isLoading?: boolean
  /** Additional content to render when expanded (e.g. upcoming jobs) */
  expandedContent?: React.ReactNode
  /** Optional callback when header is clicked (overrides default expand behavior) */
  onHeaderClick?: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────

function statusIcon(status: ServiceStatus) {
  switch (status) {
    case 'ok':
      return <CheckCircle size={14} className="text-emerald-400" />
    case 'degraded':
      return <AlertTriangle size={14} className="text-amber-400" />
    case 'error':
      return <XCircle size={14} className="text-red-400" />
    case 'unknown':
    default:
      return <MinusCircle size={14} className="text-zinc-500" />
  }
}

function statusBadgeIcon(healthy: number, total: number) {
  if (healthy === total) {
    return <CheckCircle size={10} className="text-emerald-400" />
  }
  return <AlertTriangle size={10} className="text-amber-400" />
}

// ─── Component ────────────────────────────────────────────────────────

export function HealthStatusCard({
  title,
  description,
  icon: Icon,
  iconColor,
  iconBg,
  services,
  isLoading,
  expandedContent,
  onHeaderClick,
}: HealthStatusCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const healthyCount = services.filter(s => s.status === 'ok').length
  const totalCount = services.length

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
      {/* Header — always visible, tap to expand */}
      <button
        type="button"
        className="flex w-full items-center gap-2.5 text-left sm:gap-3"
        onClick={() => onHeaderClick ? onHeaderClick() : setIsExpanded(prev => !prev)}
      >
        {/* Icon badge */}
        <div className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconBg)}>
          <Icon size={14} className={iconColor} />
        </div>

        {/* Title / description */}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-white sm:text-sm">{title}</p>
          <p className="truncate text-[11px] text-zinc-400 sm:text-xs">{description}</p>
        </div>

        {/* Status badge */}
        {isLoading
          ? (
              <span className="flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-400">
                …
              </span>
            )
          : (
              <span className="flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-1">
                {statusBadgeIcon(healthyCount, totalCount)}
                <span className="text-xs font-medium text-zinc-400">
                  {healthyCount}
                  /
                  {totalCount}
                </span>
              </span>
            )}

        {/* Chevron */}
        <ChevronRight
          size={14}
          className={clsx(
            'shrink-0 text-zinc-500 transition-transform duration-200',
            isExpanded && 'rotate-90',
          )}
        />
      </button>

      {/* Expanded service rows */}
      {isExpanded && (
        <div className="mt-3 border-t border-zinc-800 pt-3">
          <div className="space-y-2">
            {services.map(service => (
              <div key={service.name} className="flex items-start gap-2.5 py-1">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white">{service.name}</p>
                  {service.description && (
                    <p className="text-xs text-zinc-400 truncate">{service.description}</p>
                  )}
                  {service.detail && (
                    <p className="text-[11px] text-zinc-500 truncate">{service.detail}</p>
                  )}
                </div>
                {statusIcon(service.status)}
              </div>
            ))}
          </div>

          {expandedContent && (
            <div className="mt-3 border-t border-zinc-800 pt-3">
              {expandedContent}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
