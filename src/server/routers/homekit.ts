import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import QRCode from 'qrcode'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'
import { eq } from 'drizzle-orm'
import {
  disable as disableHomeKit,
  enable as enableHomeKit,
  regeneratePairing,
  status as homekitStatus,
  unpair,
} from '@/src/homekit'
import { loadOrCreateIdentity, probeSeedSources } from '@/src/homekit/storage'

const statusSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  pincode: z.string().nullable(),
  setupId: z.string().nullable(),
  setupURI: z.string().nullable(),
  qrDataUrl: z.string().nullable(),
  pairedControllers: z.array(z.string()),
})

async function buildStatus(): Promise<z.infer<typeof statusSchema>> {
  const [row] = await db
    .select({ homekitEnabled: deviceSettings.homekitEnabled })
    .from(deviceSettings)
    .where(eq(deviceSettings.id, 1))
    .limit(1)

  const s = homekitStatus()
  const qrDataUrl = s.setupURI
    ? await QRCode.toDataURL(s.setupURI, { errorCorrectionLevel: 'Q', margin: 1 })
    : null

  return {
    enabled: Boolean(row?.homekitEnabled),
    running: s.running,
    pincode: s.pincode,
    setupId: s.setupId,
    setupURI: s.setupURI,
    qrDataUrl,
    pairedControllers: s.pairedControllers,
  }
}

export const homekitRouter = router({
  getStatus: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/homekit/status', protect: false, tags: ['HomeKit'] } })
    .input(z.object({}))
    .output(statusSchema)
    .query(buildStatus),

  setEnabled: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/homekit/enabled', protect: false, tags: ['HomeKit'] } })
    .input(z.object({ enabled: z.boolean() }))
    .output(statusSchema)
    .mutation(async ({ input }) => {
      try {
        // Apply the lifecycle change first; only persist the DB flag once
        // the bridge is in the requested state. A failure here (port 51827
        // bound, mDNS error, dac monitor not ready) leaves DB and runtime
        // in agreement so a retry can re-attempt cleanly.
        if (input.enabled) await enableHomeKit()
        else await disableHomeKit()

        await db
          .update(deviceSettings)
          .set({ homekitEnabled: input.enabled, updatedAt: new Date() })
          .where(eq(deviceSettings.id, 1))

        return await buildStatus()
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to toggle HomeKit: ${error instanceof Error ? error.message : 'unknown'}`,
          cause: error,
        })
      }
    }),

  unpair: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/homekit/unpair', protect: false, tags: ['HomeKit'] } })
    .input(z.object({}))
    .output(statusSchema)
    .mutation(async () => {
      await unpair()
      return await buildStatus()
    }),

  regenerate: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/homekit/regenerate', protect: false, tags: ['HomeKit'] } })
    .input(z.object({}))
    .output(statusSchema)
    .mutation(async () => {
      await regeneratePairing()
      return await buildStatus()
    }),

  // Diagnostic — reports which seed source the identity-derivation chain
  // (ADR 0020) would pick on this pod, plus the current identity's
  // recorded source/rotation. No seed values are exposed.
  seedProbe: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/homekit/seed-probe', protect: false, tags: ['HomeKit'] } })
    .input(z.object({}))
    .output(z.object({
      resolved: z.string(),
      sources: z.array(z.object({
        source: z.string(),
        path: z.string().nullable(),
        present: z.boolean(),
        readable: z.boolean(),
        looksDegenerate: z.boolean(),
      })),
      identity: z.object({
        derivedFrom: z.string().nullable(),
        rotation: z.number().nullable(),
        derivedAt: z.number().nullable(),
        legacy: z.boolean(),
      }),
    }))
    .query(() => {
      const probe = probeSeedSources()
      const id = loadOrCreateIdentity()
      const legacy = id.derivedFrom === undefined
      return {
        resolved: probe.resolved,
        sources: probe.sources,
        identity: {
          derivedFrom: id.derivedFrom ?? null,
          rotation: typeof id.rotation === 'number' ? id.rotation : null,
          derivedAt: typeof id.derivedAt === 'number' ? id.derivedAt : null,
          legacy,
        },
      }
    }),
})
