/**
 * Token-based Recharts styling shared by the System screen charts. Values are
 * CSS variables so the charts follow the light/dark theme without re-render.
 */

/** `--font-mono` is an inline @theme token (not emitted), so use the next/font var. */
export const MONO_FONT = 'var(--font-plex-mono), "IBM Plex Mono", monospace'

export const AXIS_TICK = { fill: 'var(--text-3)', fontSize: 10, fontFamily: MONO_FONT }

export const TOOLTIP_STYLE = {
  backgroundColor: 'var(--surface-card)',
  border: '1px solid var(--border-2)',
  borderRadius: 8,
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: 'var(--text-1)',
}

export const TOOLTIP_LABEL_STYLE = { color: 'var(--text-2)' }
