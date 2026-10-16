import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { podRawInspectionLocation, rawSourceNameSchema } from './raw-inspection-child'

/** An archive holds about 15 minutes and is closed when full, so its write time marks the end of its events. */
const ARCHIVE_SPAN_MS = 20 * 60_000
const MAX_LOCATED = 400

/**
 * Archives likely to hold events in [startMs, endMs], oldest first, each with
 * the cursor that makes the inspector read exactly it (the inspector takes
 * the first name after its cursor, in the same plain name order).
 * Write times only narrow the search; inspection establishes the event bounds.
 */
export function locateRawArchives(startMs: number, endMs: number, directory = podRawInspectionLocation.archiveDirectory) {
  let names: string[]
  try {
    names = readdirSync(directory).filter(name => rawSourceNameSchema.safeParse(name).success).sort()
  }
  catch {
    return []
  }
  const located: Array<{ name: string, afterName: string | null }> = []
  for (let i = 0; i < names.length && located.length < MAX_LOCATED; i++) {
    let writtenMs: number
    try {
      writtenMs = statSync(join(directory, names[i])).mtimeMs
    }
    catch {
      continue
    }
    if (writtenMs >= startMs && writtenMs - ARCHIVE_SPAN_MS <= endMs) located.push({ name: names[i], afterName: i > 0 ? names[i - 1] : null })
  }
  return located
}
