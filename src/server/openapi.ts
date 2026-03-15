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
  return generateOpenApiDocument(appRouter, {
    title: 'Sleepypod Core API',
    version: API_VERSION,
    baseUrl,
    description:
      'REST-style API for the Sleepypod Pod controller. '
      + 'All endpoints are also available via tRPC at /api/trpc.',
    tags: ['Health', 'Device', 'Settings', 'Schedules', 'Biometrics', 'System', 'Environment', 'Raw', 'Calibration'],
    securitySchemes: {},
  })
}
