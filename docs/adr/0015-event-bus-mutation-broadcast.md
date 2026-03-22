# ADR: Event Bus for Device Mutations

**Status**: Accepted
**Date**: 2026-03-22

## Context

When multiple clients (phones, M5 dials, web browsers) are connected to the pod, a temperature change from one client takes up to 30 seconds to appear on others. The delay comes from DacMonitor's 2-second poll interval plus client-side polling intervals.

The WebSocket server (`piezoStream` on port 3001) already broadcasts `deviceStatus` frames from DacMonitor's poll loop, and all clients already consume these frames. The infrastructure for instant push exists — it just isn't triggered after mutations.

Additionally, the `claim_processing` / `activeClient` / `processingState` protocol is dead code. No client sends `claim_processing` messages. It was originally designed for iOS processing ownership of the piezo stream, but the iOS app now uses HTTP for all writes and WebSocket for read-only subscriptions.

## Decision

### 1. Broadcast device status after mutations

Add `broadcastMutationStatus()` to the device router. After `setTemperature`, `setPower`, `setAlarm`, `clearAlarm`, and `snoozeAlarm` succeed at the hardware level, overlay the mutation onto `dacMonitor.getLastStatus()` and call `broadcastFrame()` with a `deviceStatus` frame.

This is fire-and-forget — it never blocks the HTTP response. DacMonitor's 2-second poll remains the authoritative consistency backstop (it reads actual hardware state).

### 2. Remove claim_processing

Delete `processingState.ts` and strip all `activeClient`, `heartbeatTimer`, `resetHeartbeatTimer()`, `releaseClient()`, and claim/release/heartbeat message handlers from `piezoStream.ts`. Remove `getProcessingStatus` from the biometrics router. Remove client-side heartbeat sending from `useSensorStream.ts`.

The WebSocket becomes a pure read-only pub/sub channel.

## Architecture

```mermaid
graph LR
    subgraph "Clients (read-only WS + write via HTTP)"
        PhoneA["Phone A"]
        PhoneB["Phone B"]
        Dial["M5 Dial"]
        Web["Web App"]
    end

    subgraph "sleepypod-core"
        API["tRPC API :3000<br/>(all writes)"]
        WS["WebSocket :3001<br/>(read-only pub/sub)"]
        MON["DacMonitor<br/>(2s poll)"]
        DAC["dac.sock<br/>(hardware)"]
    end

    PhoneA -- "POST /device/temperature" --> API
    Dial -- "POST /device/temperature" --> API
    API -- "after success" --> WS
    MON -- "status:updated" --> WS
    WS -- "deviceStatus frame" --> PhoneA & PhoneB & Dial & Web
    MON -- "poll 2s" --> DAC
    API -- "SequentialQueue" --> DAC
```

### Data flow overview

```mermaid
graph TD
    Client["Client<br/>(phone, dial, browser)"]
    API["tRPC API :3000"]
    DAC["dac.sock<br/>hardware"]
    MON["DacMonitor<br/>2s poll"]
    WS["WebSocket :3001<br/>read-only pub/sub"]

    Client -->|"HTTP mutation"| API
    API -->|"hardware cmd"| DAC
    API -->|"broadcastMutationStatus()"| WS
    DAC -->|"poll response"| MON
    MON -->|"status:updated"| WS
    WS -->|"deviceStatus frame"| Client
```

## Consequences

**Positive:**
- Multi-client latency drops from up to 30s to ~200ms (temperature debounce)
- ~79 lines of dead code removed (net −135/+56)
- WebSocket protocol simplified — no claim/release state machine
- No new dependencies or infrastructure

**Negative:**
- Mutation broadcast uses `getLastStatus()` as the base, which may be up to 2s stale for fields not part of the mutation. DacMonitor's next poll corrects this.
- If `getLastStatus()` is null (monitor not yet started), no broadcast occurs. The 2s poll backstop handles this edge case.

**Neutral:**
- `device.getStatus` tRPC endpoint still exists for initial page load, non-WebSocket clients (iOS, CLI), and fallback when WS is unavailable.
