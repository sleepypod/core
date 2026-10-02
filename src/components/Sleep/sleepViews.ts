export type SleepSection = 'nights' | 'biometrics'

/** Nights is the landing page and stays first; the rest are A–Z. */
export const SLEEP_SECTIONS: ReadonlyArray<{ id: SleepSection, label: string }> = [
  { id: 'nights', label: 'Nights' },
  { id: 'biometrics', label: 'Biometrics' },
]

/** Resolve `?view=` — anything but Biometrics lands on Nights. */
export function resolveSleepSection(raw: string | null): SleepSection {
  return raw === 'biometrics' ? 'biometrics' : 'nights'
}
