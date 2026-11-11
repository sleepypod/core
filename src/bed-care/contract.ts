import { z } from 'zod'

export const CARE_MAX_AGE_MS = 30_000
export const careCheckSchema = z.object({
  id: z.enum(['water', 'circulation', 'recording', 'storage', 'backup']),
  title: z.string(),
  state: z.enum(['checked', 'attention', 'unknown', 'busy']),
  detail: z.string(),
  nextStep: z.string(),
  observedAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  destination: z.enum(['thermal', 'dashboard', 'health', 'storage', 'databases']),
  evidence: z.array(z.object({ title: z.string(), detail: z.string() })),
})
export const bedCareSchema = z.object({
  apiVersion: z.literal(1),
  generatedAt: z.number().int().nonnegative(),
  checks: z.array(careCheckSchema),
  lastExportAt: z.number().int().nonnegative().nullable(),
})
export type CareCheck = z.infer<typeof careCheckSchema>
export type BedCare = z.infer<typeof bedCareSchema>

/** A fresh response cannot make an older or failed source current. */
export function careCheckCurrent(check: CareCheck, now: number): boolean {
  return check.observedAt !== null && check.expiresAt !== null
    && check.observedAt <= now && check.observedAt >= now - CARE_MAX_AGE_MS
    && check.expiresAt > now && check.expiresAt <= check.observedAt + CARE_MAX_AGE_MS
}
