import type { z } from 'zod'
import type { Side } from '@/src/hardware/types'
import { historyDayStart, shiftHistoryDate, sourceDate } from '@/src/lib/localDates'
import { JournalError, journalPageSchema, journalReadSchema, journalWriteSchema, type JournalWrite, type JournalPage } from './contract'
import type { createJournalStore } from './store'
import type { JournalPresence } from './presence'
import { journalPatterns } from './patterns'

interface JournalDependencies {
  store: ReturnType<typeof createJournalStore>
  now(): number
  timeZone(): string
  withSideLock<Result>(side: Side, work: () => Promise<Result>): Promise<Result>
  presence(side: Side, from: string, through: string, timeZone: string): Array<{ source: 'sleepypod' | 'free-sleep', presence: JournalPresence }>
}

export class JournalService {
  constructor(private readonly deps: JournalDependencies) {}

  read(request: z.input<typeof journalReadSchema>): JournalPage {
    const input = journalReadSchema.parse(request)
    const timeZone = this.deps.timeZone()
    const deviceDate = sourceDate(this.deps.now() / 1000, timeZone)
    const through = input.date ?? deviceDate
    this.validateDate(through, timeZone, deviceDate)
    const candidate = shiftHistoryDate(through, 1 - input.days)
    const from = candidate < '1970-01-01' ? '1970-01-01' : candidate
    const entries = this.deps.store.list(input.side, from, through)
    return journalPageSchema.parse({ apiVersion: 1, side: input.side, timeZone, deviceDate, from, through,
      selected: this.deps.store.read(input.side, through), entries,
      patterns: journalPatterns(entries, this.deps.presence(input.side, from, through, timeZone)) })
  }

  async write(request: JournalWrite) {
    const input = journalWriteSchema.parse(request)
    return this.deps.withSideLock(input.side, async () => {
      const now = this.deps.now()
      const timeZone = this.deps.timeZone()
      this.validateDate(input.date, timeZone, sourceDate(now / 1000, timeZone))
      return this.deps.store.write(input, timeZone, now)
    })
  }

  private validateDate(date: string, timeZone: string, today: string): void {
    if (date > today) throw new JournalError('A morning check-in cannot describe a future local date.', 'BAD_REQUEST')
    try {
      historyDayStart(date, timeZone)
    }
    catch { throw new JournalError('That calendar date does not occur in the Pod time zone.', 'BAD_REQUEST') }
  }
}
