/** Independent staging and importer budgets; the client allows both plus response cleanup. */
export const WATCH_UPLOAD_TIMEOUT_MS = 30 * 60_000
export const WATCH_IMPORT_TIMEOUT_MS = 10 * 60_000
export const WATCH_REQUEST_TIMEOUT_MS = WATCH_UPLOAD_TIMEOUT_MS + WATCH_IMPORT_TIMEOUT_MS + 60_000
