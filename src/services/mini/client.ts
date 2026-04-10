/**
 * Snoo API client — OAuth auth and data API.
 * TypeScript port of pysnoo2's auth_session.py + snoo.py.
 */

import type {
  AggregatedSessionAvg,
  AggregatedSessionInterval,
  Baby,
  BabyUpdate,
  Device,
  LastSession,
  SnooToken,
  User,
} from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNOO_API = 'https://api-us-east-1-prod.happiestbaby.com'

const ENDPOINTS = {
  login: `${SNOO_API}/us/v3/login`,
  refresh: `${SNOO_API}/us/v2/refresh/`,
  me: `${SNOO_API}/us/me/v10/me`,
  devices: `${SNOO_API}/hds/me/v11/devices`,
  baby: `${SNOO_API}/us/me/v10/baby`,
  sessionsLast: (babyId: string) => `${SNOO_API}/ss/me/v10/babies/${babyId}/sessions/last`,
  sessionsAvg: (babyId: string) => `${SNOO_API}/ss/v2/babies/${babyId}/sessions/aggregated/avg/`,
  sessionsTotalTime: (babyId: string) => `${SNOO_API}/ss/v2/babies/${babyId}/sessions/total-time/`,
  pubnubAuth: `${SNOO_API}/us/me/v10/pubnub/authorize`,
} as const

const BASE_HEADERS = {
  'User-Agent': 'okhttp/4.7.2',
  'Content-Type': 'application/json;charset=UTF-8',
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SnooClient {
  private token: SnooToken | null = null
  private username: string | null = null
  private password: string | null = null
  private onTokenUpdate?: (token: SnooToken) => void

  constructor(opts?: { onTokenUpdate?: (token: SnooToken) => void }) {
    this.onTokenUpdate = opts?.onTokenUpdate
  }

  /** Restore a previously-persisted token (skips login). */
  setToken(token: SnooToken): void {
    this.token = token
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async authenticate(username: string, password: string): Promise<SnooToken> {
    this.username = username
    this.password = password
    return this.fetchToken()
  }

  private async fetchToken(): Promise<SnooToken> {
    const res = await fetch(ENDPOINTS.login, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify({ username: this.username, password: this.password }),
    })
    if (!res.ok) {
      throw new Error(`Snoo login failed: ${res.status} ${res.statusText}`)
    }
    const data = await res.json() as SnooToken
    this.token = data
    this.onTokenUpdate?.(data)
    return data
  }

  private async refreshToken(): Promise<SnooToken> {
    if (!this.token?.refreshToken) {
      throw new Error('No refresh token available')
    }
    const res = await fetch(ENDPOINTS.refresh, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify({ refreshToken: this.token.refreshToken }),
    })
    if (!res.ok) {
      // Refresh failed — try full re-auth if credentials are available
      if (this.username && this.password) {
        return this.fetchToken()
      }
      throw new Error(`Snoo token refresh failed: ${res.status} ${res.statusText}`)
    }
    const data = await res.json() as SnooToken
    this.token = data
    this.onTokenUpdate?.(data)
    return data
  }

  // -------------------------------------------------------------------------
  // Authenticated fetch with auto-refresh on 401/403
  // -------------------------------------------------------------------------

  private async authedFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!this.token) throw new Error('Not authenticated — call authenticate() first')

    const doFetch = (accessToken: string) =>
      fetch(url, {
        ...init,
        headers: {
          ...BASE_HEADERS,
          Authorization: `Bearer ${accessToken}`,
          ...init?.headers,
        },
      })

    let res = await doFetch(this.token.accessToken)

    if (res.status === 401 || res.status === 403) {
      const refreshed = await this.refreshToken()
      res = await doFetch(refreshed.accessToken)
    }

    if (!res.ok) {
      throw new Error(`Snoo API ${init?.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText}`)
    }
    return res
  }

  // -------------------------------------------------------------------------
  // Data API
  // -------------------------------------------------------------------------

  async getMe(): Promise<User> {
    const res = await this.authedFetch(ENDPOINTS.me)
    return await res.json() as User
  }

  async getDevices(): Promise<Device[]> {
    const res = await this.authedFetch(ENDPOINTS.devices)
    const data = await res.json() as { snoo: Device[] }
    return data.snoo
  }

  async getBaby(): Promise<Baby> {
    const res = await this.authedFetch(ENDPOINTS.baby)
    return await res.json() as Baby
  }

  async updateBaby(update: BabyUpdate): Promise<Baby> {
    const res = await this.authedFetch(ENDPOINTS.baby, {
      method: 'PATCH',
      body: JSON.stringify(update),
    })
    return await res.json() as Baby
  }

  async getLastSession(babyId: string): Promise<LastSession> {
    const res = await this.authedFetch(ENDPOINTS.sessionsLast(babyId))
    return await res.json() as LastSession
  }

  async getSessionsAvg(
    babyId: string,
    startTime: Date,
    interval: AggregatedSessionInterval,
    includeDays: boolean = false,
  ): Promise<AggregatedSessionAvg> {
    const fmt = startTime.toISOString().replace('T', ' ').slice(0, 23)
    const params = new URLSearchParams({
      startTime: fmt,
      interval,
      days: String(includeDays),
    })
    const res = await this.authedFetch(`${ENDPOINTS.sessionsAvg(babyId)}?${params}`)
    return await res.json() as AggregatedSessionAvg
  }

  async getTotalTime(babyId: string): Promise<number> {
    const res = await this.authedFetch(ENDPOINTS.sessionsTotalTime(babyId))
    const data = await res.json() as { totalTime: number }
    return data.totalTime
  }

  // -------------------------------------------------------------------------
  // PubNub token
  // -------------------------------------------------------------------------

  async getPubNubToken(): Promise<string> {
    const res = await this.authedFetch(ENDPOINTS.pubnubAuth, { method: 'POST' })
    const data = await res.json() as { snoo: { token: string } }
    return data.snoo.token
  }
}
