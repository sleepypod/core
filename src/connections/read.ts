import { sqlite } from '@/src/db'
import { readOrCreateConnectionIdentity } from './identity'

/** Owner enrollment creates at most one local metadata row; it does not start or query hardware. */
export function readConnectionIdentity(): string {
  return readOrCreateConnectionIdentity(sqlite)
}
