import { sqlite, biometricsDb } from '@/src/db'
import { withSideLock } from '@/src/hardware/sideLock'
import { importedHistoryReader } from '@/src/history/read'
import { createJournalStore } from './store'
import { readJournalPresence } from './presence'
import { JournalService } from './service'
import { JournalError } from './contract'

/** Reading or writing a check-in never starts hardware, automation, or a cloud model. */
export function journalService(): JournalService {
  return new JournalService({
    store: createJournalStore(sqlite), now: Date.now, withSideLock,
    timeZone: () => {
      const row = sqlite.prepare('SELECT timezone FROM device_settings LIMIT 1').get() as { timezone: string } | undefined
      if (!row?.timezone) throw new JournalError('Set the Pod time zone before using the journal.', 'PRECONDITION_FAILED')
      try {
        new Intl.DateTimeFormat('en', { timeZone: row.timezone }).format(0)
      }
      catch { throw new JournalError('The saved Pod time zone is unavailable.', 'PRECONDITION_FAILED') }
      return row.timezone
    },
    presence: (side, from, through, timeZone) => {
      let current
      try {
        current = readJournalPresence(biometricsDb.$client, side, from, through, timeZone)
      }
      catch { current = { status: 'unavailable' as const, timeZone, minutes: new Map<string, number>() } }
      return [{ source: 'sleepypod', presence: current }, { source: 'free-sleep', presence: importedHistoryReader().journalPresence(side, from, through) }]
    },
  })
}
