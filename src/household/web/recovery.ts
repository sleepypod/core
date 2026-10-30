import { identityKey, PersonalWebError, recoveryReferenceSchema, type RecoveryReference } from './protocol'
import type { HouseholdSession } from '../contract'
export interface RecoveryJournal {
  list(session: HouseholdSession): Promise<RecoveryReference[]>
  reserve(reference: RecoveryReference, allowAdditional?: boolean): Promise<void>
  remove(reference: RecoveryReference): Promise<void>
}
const DATABASE_NAME = 'sleepypod-personal-recovery-v1'
const STORE_NAME = 'references'
const CAPACITY = 64
/** One IndexedDB transaction reserves recovery space across tabs before a POST. */
export class BrowserRecoveryJournal implements RecoveryJournal {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {
  }

  private open(): Promise<IDBDatabase> {
    const factory = this.factory
    if (!factory) return Promise.reject(this.failure())
    return new Promise((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, 1)
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        reject(this.failure())
      }, 5000)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'requestId' })
        store.createIndex('identityKey', 'identityKey')
      }
      request.onsuccess = () => {
        clearTimeout(timeout)
        if (settled) {
          request.result.close()
          return
        }
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => {
        settled = true
        clearTimeout(timeout)
        reject(this.failure())
      }
    })
  }

  private failure() {
    return new PersonalWebError('storage', 'Private command recovery is unavailable. No new command can be sent until it is working.')
  }

  private async transaction<Result>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, result: (value: Result) => void, fail: (error: Error) => void) => void): Promise<Result> {
    const database = await this.open()
    try {
      return await new Promise<Result>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode)
        let value: Result, failure: Error | undefined
        const timeout = setTimeout(() => {
          failure = this.failure()
          transaction.abort()
        }, 5000)
        transaction.oncomplete = () => {
          clearTimeout(timeout)
          resolve(value)
        }
        transaction.onabort = transaction.onerror = () => {
          clearTimeout(timeout)
          reject(failure ?? this.failure())
        }
        try {
          operation(transaction.objectStore(STORE_NAME), result => value = result, (error) => {
            failure = error
            transaction.abort()
          })
        }
        catch (error) {
          failure = error instanceof Error ? error : this.failure()
          transaction.abort()
        }
      })
    }
    finally {
      database.close()
    }
  }

  async list(session: HouseholdSession) {
    return this.transaction<RecoveryReference[]>('readonly', (store, result, fail) => {
      const request = store.index('identityKey').getAll(identityKey(session))
      request.onsuccess = () => {
        try {
          const records = request.result.map(value => recoveryReferenceSchema.parse(value))
          if (records.some(value => value.identityKey !== identityKey(session)))
            throw this.failure()
          result(records)
        }
        catch {
          fail(this.failure())
        }
      }
    })
  }

  async reserve(input: RecoveryReference, allowAdditional = false) {
    const reference = recoveryReferenceSchema.parse(input)
    return this.transaction<undefined>('readwrite', (store, result, fail) => {
      const count = store.count()
      count.onsuccess = () => {
        if (count.result >= CAPACITY)
          return fail(new PersonalWebError('storage', 'Recovery storage is full. Review previous commands before sending another.'))
        const own = store.index('identityKey').getAll(reference.identityKey)
        own.onsuccess = () => {
          if (!allowAdditional && own.result.length > 0)
            return fail(new PersonalWebError('pending', 'Review the earlier saved result before making another change.'))
          store.add(reference).onsuccess = () => result(undefined)
        }
      }
    })
  }

  async remove(reference: RecoveryReference) {
    return this.transaction<undefined>('readwrite', (store, result, fail) => {
      const request = store.get(reference.requestId)
      request.onsuccess = () => {
        if (request.result === undefined)
          return result(undefined)
        if (JSON.stringify(request.result) !== JSON.stringify(reference))
          return fail(this.failure())
        store.delete(reference.requestId).onsuccess = () => result(undefined)
      }
    })
  }
}
