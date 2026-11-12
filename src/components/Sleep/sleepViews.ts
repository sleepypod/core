export type SleepSection = 'nights' | 'biometrics' | 'history' | 'journal' | 'reports'

/** Nights is the landing page and stays first; the rest are A–Z. */
export const SLEEP_SECTIONS: ReadonlyArray<{ id: SleepSection, label: string }> = [
  { id: 'nights', label: 'Nights' },
  { id: 'biometrics', label: 'Biometrics' },
  { id: 'history', label: 'History' },
  { id: 'journal', label: 'Journal' },
  { id: 'reports', label: 'Reports' },
]

/** Preserve Nights as the landing page for unknown bookmarks. */
export function resolveSleepSection(raw: string | null): SleepSection {
  return raw === 'biometrics' || raw === 'history' || raw === 'journal' || raw === 'reports' ? raw : 'nights'
}
