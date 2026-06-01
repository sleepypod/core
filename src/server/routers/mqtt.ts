import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'
import {
  getBridgeStatus,
  resolveConfig,
  shutdownMqttBridge,
  startMqttBridge,
  testConnection,
} from '@/src/streaming/mqttBridge'

const sourceSchema = z.enum(['db', 'env', 'default'])

const settingsSchema = z.object({
  enabled: z.boolean(),
  url: z.string().nullable(),
  username: z.string().nullable(),
  // Password is write-only; getSettings reports `passwordIsSet` instead so the
  // UI can render "•••" without leaking the value.
  passwordIsSet: z.boolean(),
  topicPrefix: z.string(),
  haDiscovery: z.boolean(),
  tlsEnabled: z.boolean(),
  sources: z.object({
    enabled: sourceSchema,
    url: sourceSchema,
    username: sourceSchema,
    password: sourceSchema,
    topicPrefix: sourceSchema,
    haDiscovery: sourceSchema,
    tlsEnabled: sourceSchema,
  }),
})

const updateInputSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    url: z.string().url().nullable().optional(),
    username: z.string().nullable().optional(),
    // null clears the stored password; undefined leaves it untouched.
    password: z.string().nullable().optional(),
    topicPrefix: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_/-]+$/).nullable().optional(),
    haDiscovery: z.boolean().nullable().optional(),
    tlsEnabled: z.boolean().nullable().optional(),
  })
  .strict()

/**
 * MQTT bridge configuration router.
 *
 * Settings UI calls these endpoints. Writes always target device_settings
 * (singleton row id=1); the bridge resolves DB > env > default at start and
 * after every settings update. Password is write-only: getSettings reports
 * whether one is set but never returns the value.
 */
export const mqttRouter = router({
  /**
   * Resolved bridge configuration with per-field source attribution.
   *
   * The Settings UI uses `source` to render "Set in environment" hints next
   * to fields the operator can't override via the UI alone.
   */
  getSettings: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/mqtt/settings', protect: false, tags: ['MQTT'] } })
    .input(z.object({}))
    .output(settingsSchema)
    .query(async () => {
      const { config, sources } = await resolveConfig()
      const passwordIsSet = config.password !== null && config.password.length > 0
      // When no password is set anywhere, sources.password is whichever layer
      // was checked last — surface that as 'default' so the UI doesn't claim
      // a password came from env when none exists at all.
      const passwordSource = passwordIsSet ? sources.password : 'default'
      return {
        enabled: config.enabled,
        url: config.url,
        username: config.username,
        passwordIsSet,
        topicPrefix: config.topicPrefix,
        haDiscovery: config.haDiscovery,
        tlsEnabled: config.tlsEnabled,
        sources: {
          enabled: sources.enabled,
          url: sources.url,
          username: sources.username,
          password: passwordSource,
          topicPrefix: sources.topicPrefix,
          haDiscovery: sources.haDiscovery,
          tlsEnabled: sources.tlsEnabled,
        },
      }
    }),

  /**
   * Persist a partial update to device_settings and restart the bridge so
   * the new config takes effect. `null` clears a field (falls back to env).
   */
  updateSettings: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/mqtt/settings', protect: false, tags: ['MQTT'] } })
    .input(updateInputSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        const updates: Record<string, unknown> = { updatedAt: new Date() }
        if ('enabled' in input) updates.mqttEnabled = input.enabled ?? null
        if ('url' in input) updates.mqttUrl = input.url ?? null
        if ('username' in input) updates.mqttUsername = input.username ?? null
        if ('password' in input) updates.mqttPassword = input.password ?? null
        if ('topicPrefix' in input) updates.mqttTopicPrefix = input.topicPrefix ?? null
        if ('haDiscovery' in input) updates.mqttHaDiscovery = input.haDiscovery ?? null
        if ('tlsEnabled' in input) updates.mqttTlsEnabled = input.tlsEnabled ?? null

        await db.update(deviceSettings).set(updates).where(eq(deviceSettings.id, 1))
      }
      catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to update MQTT settings: ${err instanceof Error ? err.message : 'Unknown error'}`,
          cause: err,
        })
      }

      // Restart so the resolved config is picked up. Fire-and-forget — a
      // misconfigured broker should not stall the mutation while mqtt.js
      // exhausts its CONNECT_TIMEOUT_MS. Errors surface via getStatus.
      void (async () => {
        try {
          await shutdownMqttBridge()
          await startMqttBridge()
        }
        catch (err) {
          console.warn('[mqtt] restart after settings update failed:', err instanceof Error ? err.message : err)
        }
      })()

      return { success: true }
    }),

  /**
   * Try to connect to the supplied broker without persisting anything.
   * Used by the Settings UI's "Test connection" button.
   */
  testConnection: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/mqtt/test-connection', protect: false, tags: ['MQTT'] } })
    .input(z.object({
      url: z.string().url(),
      username: z.string().nullable().optional(),
      password: z.string().nullable().optional(),
      tlsEnabled: z.boolean().optional(),
    }).strict())
    .output(z.object({ ok: z.boolean(), error: z.string().optional() }))
    .mutation(async ({ input }) => {
      return testConnection({
        url: input.url,
        username: input.username ?? null,
        password: input.password ?? null,
        tlsEnabled: input.tlsEnabled ?? false,
      })
    }),

  /**
   * Live bridge status for the Settings UI to render an indicator without
   * scraping logs.
   */
  getStatus: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/mqtt/status', protect: false, tags: ['MQTT'] } })
    .input(z.object({}))
    .output(z.object({
      runState: z.enum(['stopped', 'starting', 'connected', 'reconnecting', 'errored']),
      connected: z.boolean(),
      lastError: z.string().nullable(),
      deviceId: z.string(),
      topicPrefix: z.string().nullable(),
      messagesPublished: z.number(),
      lastPublishAt: z.string().nullable(),
    }))
    .query(() => getBridgeStatus()),
})
