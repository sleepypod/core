import Database from 'better-sqlite3'
import { evaluatePredictiveRecording } from './predictive-worker'
import { createPredictiveRecordings, predictiveContentHash } from './predictive-recording-store'
import { predictiveStatusRequestSchema } from './predictive-recording-contract'
import { predictiveOutcomeRequestSchema } from './predictive-outcome-contract'
import { evaluatePredictiveOutcomes } from './predictive-outcomes'

// Dedicated child: bounded stdin/stdout, no live app imports and no writable connection.
let incoming = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  incoming += chunk
  if (Buffer.byteLength(incoming) > 4096) process.exit(1)
})
process.stdin.on('end', () => {
  const databases: Database.Database[] = []
  try {
    if (process.argv.length !== 4) throw new Error('Two database paths are required.')
    for (const filename of process.argv.slice(2)) {
      const database = new Database(filename, { readonly: true, fileMustExist: true, timeout: 500 })
      database.pragma('query_only = ON')
      databases.push(database)
    }
    const input: unknown = JSON.parse(incoming)
    const status = predictiveStatusRequestSchema.safeParse(input)
    const outcomes = predictiveOutcomeRequestSchema.safeParse(input)
    const value = status.success
      ? { version: 1, requestHash: predictiveContentHash(status.data),
          data: createPredictiveRecordings(databases[0]).status(status.data.side, status.data.at) }
      : outcomes.success
        ? { version: 1, requestHash: predictiveContentHash(outcomes.data),
            data: evaluatePredictiveOutcomes(databases[0], databases[1], outcomes.data.side, outcomes.data.at) }
        : evaluatePredictiveRecording(databases[0], databases[1], input)
    const result = JSON.stringify(value)
    if (Buffer.byteLength(result) > 16_384) throw new Error('Oversized result.')
    process.stdout.write(result)
  }
  catch { process.exitCode = 1 }
  finally { databases.forEach(database => database.close()) }
})
