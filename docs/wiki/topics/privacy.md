# Privacy

sleepypod is designed for complete local data sovereignty.

## Core Principles

- **No cloud** — all data processed and stored locally on the Pod and iOS device
- **No analytics** — no analytics SDKs, crash reporters, or tracking code
- **No telemetry** — the Pod's stock firmware telemetry is actively blocked (see [[deployment|network security]])

## Data Handling

| Data Type | Storage | Network |
|-----------|---------|---------|
| Sleep records, vitals, movement | `biometrics.db` on Pod | Never leaves LAN |
| Temperature settings, schedules | `sleepypod.db` on Pod | Never leaves LAN |
| Heart rate, HRV, breathing rate | Processed on-device by [[piezo-processing]] | Never transmitted |

## Network Communication

sleepypod communicates exclusively over local WiFi between the Pod and iOS device. No data is sent to the internet, cloud services, or third-party servers.

Stock firmware processes (`frankenfirmware`, `Eight.Capybara`) that attempt to phone home are blocked via iptables and /etc/hosts null routes.

## Apple Health

If the user chooses to write sleep data to Apple Health, that data is governed by Apple's Health privacy policies.

## Sources

- `docs/PRIVACY.md`
