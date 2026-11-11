import type Database from 'better-sqlite3'
import { installHardwareAdmission } from './admission'
import { HardwareAdmissionStore } from './admissionStore'

const shared = globalThis as typeof globalThis & { __sp_admissionStore?: HardwareAdmissionStore }

/** Repeated Next.js initialization keeps the original authority and all queued intent revisions. */
export function startHardwareAdmission(database: Database.Database): HardwareAdmissionStore {
  if (shared.__sp_admissionStore) return shared.__sp_admissionStore
  const store = new HardwareAdmissionStore(database)
  installHardwareAdmission(store)
  shared.__sp_admissionStore = store
  return store
}
