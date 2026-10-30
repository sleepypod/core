/**
 * OpenAPI document generation from the tRPC router.
 *
 * Uses trpc-to-openapi to introspect procedure metadata and produce
 * an OpenAPI 3.1 JSON document served at /api/openapi.json.
 */
import { generateOpenApiDocument } from 'trpc-to-openapi'
import { appRouter } from './routers/app'

/** Fallback version — semantic-release manages the real version at release time. */
const API_VERSION = process.env.npm_package_version ?? '0.0.0-dev'

export function getOpenApiDocument(baseUrl: string) {
  const document = generateOpenApiDocument(appRouter, {
    title: 'Sleepypod Core API',
    version: API_VERSION,
    baseUrl,
    description:
      'REST-style API for the Sleepypod Pod controller. '
      + 'All endpoints are also available via tRPC at /api/trpc. '
      + 'Owner authentication is required: a Bearer connection key or an expiring browser session. '
      + 'Use LAN or private Tailscale access; do not expose the controller publicly.',
    tags: ['Health', 'Device', 'Settings', 'Schedules', 'Biometrics', 'Biometric tuning', 'System', 'Environment', 'Raw', 'Calibration', 'Water Level'],
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  })
  document.security = [{ bearerAuth: [] }]
  return document
}
