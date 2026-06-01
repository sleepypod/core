# sleepypod core Wiki

Knowledge base compiled from project documentation. 10 topics from 22 source files.

## Topics

### System Architecture
- [[topics/architecture-and-stack|Architecture and Stack]] — TypeScript, React, Next.js, tRPC, Drizzle/SQLite, tooling
- [[topics/api-architecture|API Architecture]] — tRPC routers, WebSocket push, event bus, frontend hooks
- [[topics/hardware-protocol|Hardware Protocol]] — DAC socket communication, wire protocol, commands

### Biometrics & Sensors
- [[topics/biometrics-system|Biometrics System]] — Plugin/sidecar module architecture, schema contract
- [[topics/piezo-processing|Piezo Processing]] — Heart rate, HRV, breathing rate from BCG signals
- [[topics/sleep-detection|Sleep Detection]] — Bed occupancy, movement scoring, session tracking
- [[topics/sensor-calibration|Sensor Calibration]] — Adaptive thresholds, medical rationale, quality scoring
- [[topics/sensor-hardware|Sensor Hardware]] — Pod sensor profiles, CBOR record types, capSense vs capSense2

### Operations
- [[topics/deployment|Deployment]] — Three paths to the Pod, Yocto constraints, network security
- [[topics/privacy|Privacy]] — Local-only data, no cloud, no analytics
