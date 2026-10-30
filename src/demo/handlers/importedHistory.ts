import type { DemoHandlers } from '../types'
import { HISTORY_SEMANTICS } from '@/src/history/contract'

export const importedHistory: DemoHandlers<'importedHistory'> = {
  status: () => ({ apiVersion: 1, status: 'not_imported', snapshot: null,
    message: 'Connect to your Pod to view its imported history. The demo contains no personal archive.', semantics: HISTORY_SEMANTICS }),
  records: () => { throw new Error('No imported personal history is available in the demo.') },
  presence: () => { throw new Error('No imported personal history is available in the demo.') },
}
