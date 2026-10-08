import { readFile } from 'node:fs/promises'
import { baseConfigurationSchema } from './types'

/** Inspect local setup without opening Bluetooth or exposing the paired address. */
export async function readBaseConfiguration() {
  const text = await readFile('/persistent/AdjustableBaseConfiguration.json', 'utf8')
  return baseConfigurationSchema.parse(JSON.parse(text))
}

export async function isBaseConfigured(): Promise<boolean> {
  try {
    await readBaseConfiguration()
    return true
  }
  catch {
    return false
  }
}
