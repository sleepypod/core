/**
 * Inline monoline icons for the Autopilot console, ported verbatim from the
 * design bundle (claude.ai/design export). Self-contained SVGs — no dependency
 * on an icon library's export names, so the visual output matches the design
 * exactly. currentColor + a tunable stroke width.
 */
import type { CSSProperties, ReactNode } from 'react'

interface IconProps { size?: number, sw?: number, className?: string, style?: CSSProperties }

function mk(paths: ReactNode, vb = '0 0 24 24') {
  return function IconCmp(p: IconProps) {
    return (
      <svg
        width={p.size ?? 16}
        height={p.size ?? 16}
        viewBox={vb}
        fill="none"
        stroke="currentColor"
        strokeWidth={p.sw ?? 1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={p.className}
        style={p.style}
      >
        {paths}
      </svg>
    )
  }
}

export const Icon = {
  Zap: mk(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none" />),
  Activity: mk(<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />),
  Thermo: mk(<path d="M14 4a2 2 0 0 0-4 0v10.5a4 4 0 1 0 4 0z" />),
  Clock: mk(
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </>
  ),
  Moon: mk(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />),
  Bell: mk(
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  Droplet: mk(<path d="M12 2.7 6.3 9a8 8 0 1 0 11.4 0z" />),
  Heart: mk(<path d="M19 14c1.5-1.5 3-3.4 3-5.5A4.5 4.5 0 0 0 12 5 4.5 4.5 0 0 0 2 8.5c0 2.1 1.5 4 3 5.5l7 7z" />),
  Wind: mk(
    <>
      <path d="M3 8h11a3 3 0 1 0-3-3" />
      <path d="M3 12h16a3 3 0 1 1-3 3" />
      <path d="M3 16h7a3 3 0 1 1-3 3" />
    </>
  ),
  Plus: mk(
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  Minus: mk(<path d="M5 12h14" />),
  X: mk(
    <>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </>
  ),
  Check: mk(<polyline points="20 6 9 17 4 12" />),
  ChevDown: mk(<polyline points="6 9 12 15 18 9" />),
  ChevRight: mk(<polyline points="9 6 15 12 9 18" />),
  Play: mk(<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />),
  Pause: mk(
    <>
      <rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none" />
      <rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none" />
    </>,
  ),
  List: mk(
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </>
  ),
  Pulse: mk(<path d="M3 12h4l2 6 4-12 2 6h6" />),
  Shield: mk(<path d="M12 2 4 5v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5z" />),
  Power: mk(
    <>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </>
  ),
  Flask: mk(
    <>
      <path d="M9 3h6" />
      <path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />
      <path d="M7.5 14h9" />
    </>
  ),
  Sliders: mk(
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  ArrowDown: mk(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </>
  ),
  Bed: mk(
    <>
      <path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8" />
      <path d="M2 16h20" />
      <path d="M6 10V7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </>
  ),
  Function: mk(
    <>
      <path d="M9 4H7.8A2.8 2.8 0 0 0 5 6.8V9" />
      <path d="M5 15v2.2A2.8 2.8 0 0 0 7.8 20H9" />
      <path d="M15 20h1.2a2.8 2.8 0 0 0 2.8-2.8V15" />
      <path d="M19 9V6.8A2.8 2.8 0 0 0 16.2 4H15" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="12" y1="9" x2="12" y2="15" />
    </>
  ),
  AlertTri: mk(
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  Thermometer: mk(<path d="M14 4a2 2 0 0 0-4 0v10.5a4 4 0 1 0 4 0z" />),
} as const

export type IconName = keyof typeof Icon
