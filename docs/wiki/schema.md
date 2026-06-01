# Wiki Schema

Defines the topic taxonomy for the sleepypod core knowledge base. Used by the compiler to classify source documents into topics.

## Topics

| Slug | Title | Description | Key Sources |
|------|-------|-------------|-------------|
| `architecture-and-stack` | Architecture and Stack | Core technology decisions: TypeScript, React, Next.js, tRPC, Drizzle/SQLite, tooling | ADRs 0001-0010 |
| `deployment` | Deployment | Getting code to the Pod: 3 paths, Yocto constraints, network security, Python/uv setup, free-sleep coexistence | DEPLOYMENT.md, ADR 0013, ADR 0017 |
| `hardware-protocol` | Hardware Protocol | DAC socket communication: wire protocol, commands, connection lifecycle | DAC-PROTOCOL.md, ADR 0016 |
| `biometrics-system` | Biometrics System | Plugin/sidecar module architecture, schema contract, manifest discovery | ADR 0012 |
| `piezo-processing` | Piezo Processing | HR, HRV, breathing rate from 500 Hz BCG: SHS, pump gating, presence, validation | piezo-processor.md |
| `sleep-detection` | Sleep Detection | Bed occupancy, movement (PIM), sessions from capacitance: capSense/capSense2 | sleep-detector.md |
| `sensor-calibration` | Sensor Calibration | Adaptive thresholds, CalibrationStore, medical rationale, quality scoring | ADR 0014, calibration-architecture.md |
| `sensor-hardware` | Sensor Hardware | Pod sensor profiles: CBOR record types, capSense vs capSense2, channel maps | sensor-profiles.md |
| `api-architecture` | API Architecture | tRPC routers, WebSocket push, event bus, frontend hooks | trpc-api-architecture.md, ADR 0015 |
| `privacy` | Privacy | Local-only data, no cloud/analytics/telemetry | PRIVACY.md |

## Topic Relationships

```
architecture-and-stack
├── api-architecture (uses tRPC, Drizzle)
│   ├── hardware-protocol (device router → dac.sock)
│   └── biometrics-system (biometrics router → biometrics.db)
│       ├── piezo-processing (writes vitals)
│       ├── sleep-detection (writes sleep_records, movement)
│       └── sensor-calibration (adaptive thresholds for processing modules)
│           └── sensor-hardware (pod-specific sensor formats)
├── deployment (deploys the stack to the pod)
└── privacy (design constraint across all components)
```
