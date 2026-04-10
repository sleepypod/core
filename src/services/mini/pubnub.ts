/**
 * PubNub subscription manager for real-time Snoo state and commands.
 * TypeScript port of pysnoo2's pubnub.py.
 */

import PubNub from 'pubnub'
import type { SnooClient } from './client'
import { EventType, type ActivityState, type SessionLevel, type SnooCommand } from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBSCRIBE_KEY = 'sub-c-97bade2a-483d-11e6-8b3b-02ee2ddab7fe'
const PUBLISH_KEY = 'pub-c-699074b0-7664-4be2-abf8-dcbb9b6cd2bf'
const PUBNUB_ORIGIN = 'happiestbaby.pubnubapi.com'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBoolStr(v: string): boolean {
  return v === 'on' || v === 'true'
}

function parseEventType(raw: string): EventType {
  const known = Object.values(EventType) as string[]
  return known.includes(raw) ? (raw as EventType) : EventType.UNKNOWN
}

function parseActivityState(msg: Record<string, unknown>): ActivityState {
  const sm = msg.state_machine as Record<string, unknown>
  const sig = msg.rx_signal as Record<string, unknown>

  const sinceMs = sm.since_session_start_ms as number
  const timeLeft = sm.time_left as number

  return {
    leftSafetyClip: msg.left_safety_clip as boolean,
    rightSafetyClip: msg.right_safety_clip as boolean,
    swVersion: msg.sw_version as string,
    eventTime: new Date(msg.event_time_ms as number),
    systemState: msg.system_state as string,
    event: parseEventType(msg.event as string),
    rxSignal: {
      rssi: sig.rssi as number,
      strength: sig.strength as number,
    },
    stateMachine: {
      state: sm.state as SessionLevel,
      upTransition: sm.up_transition as SessionLevel,
      downTransition: sm.down_transition as SessionLevel,
      isActiveSession: parseBoolStr(sm.is_active_session as string),
      sessionId: sm.session_id as string,
      sinceSessionStartMs: sinceMs === -1 ? null : sinceMs,
      timeLeftMs: timeLeft === -1 ? null : timeLeft,
      stickyWhiteNoise: parseBoolStr(sm.sticky_white_noise as string),
      weaning: parseBoolStr(sm.weaning as string),
      hold: parseBoolStr(sm.hold as string),
      audio: parseBoolStr(sm.audio as string),
    },
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export type ActivityListener = (state: ActivityState) => void

export class MiniPubNubManager {
  private pubnub: PubNub | null = null
  private serialNumber: string
  private apiClient: SnooClient
  private listeners: ActivityListener[] = []
  private connected = false

  constructor(serialNumber: string, apiClient: SnooClient) {
    this.serialNumber = serialNumber
    this.apiClient = apiClient
  }

  onActivity(listener: ActivityListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  async connect(): Promise<void> {
    const token = await this.apiClient.getPubNubToken()
    const uuid = `pn-sleepypod-${this.serialNumber}`

    this.pubnub = new PubNub({
      subscribeKey: SUBSCRIBE_KEY,
      publishKey: PUBLISH_KEY,
      authKey: token,
      userId: uuid,
      origin: PUBNUB_ORIGIN,
      ssl: true,
      restore: true,
    })

    this.pubnub.addListener({
      status: (status) => {
        if (status.category === 'PNConnectedCategory' || status.category === 'PNReconnectedCategory') {
          this.connected = true
        }
        if (status.category === 'PNAccessDeniedCategory') {
          this.refreshAuth()
        }
      },
      message: (msg) => {
        if (msg.channel === `ActivityState.${this.serialNumber}`) {
          const state = parseActivityState(msg.message as Record<string, unknown>)
          for (const listener of this.listeners) {
            listener(state)
          }
        }
      },
    })

    this.pubnub.subscribe({
      channels: [`ActivityState.${this.serialNumber}`],
    })
  }

  async sendCommand(command: SnooCommand): Promise<void> {
    if (!this.pubnub) throw new Error('PubNub not connected')

    await this.pubnub.publish({
      channel: `ControlCommand.${this.serialNumber}`,
      message: command as unknown as PubNub.Payload,
    })
  }

  async disconnect(): Promise<void> {
    if (!this.pubnub) return
    this.pubnub.unsubscribeAll()
    this.pubnub.destroy()
    this.pubnub = null
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  private async refreshAuth(): Promise<void> {
    try {
      const token = await this.apiClient.getPubNubToken()
      this.pubnub?.setToken(token)
    }
    catch (err) {
      console.error('[Mini PubNub] Token refresh failed:', err instanceof Error ? err.message : err)
    }
  }
}
