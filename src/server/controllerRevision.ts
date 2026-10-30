import { readFile } from 'node:fs/promises'

/** Read the packaged revision without importing controller or account state. */
export async function readControllerRevision(): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(await readFile('.git-info', 'utf-8'))
    if (typeof manifest !== 'object' || manifest === null || !('commitHash' in manifest)) return null
    return typeof manifest.commitHash === 'string' && /^[a-f0-9]{7,40}$/.test(manifest.commitHash) ? manifest.commitHash : null
  }
  catch { return null }
}
