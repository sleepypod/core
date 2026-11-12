# Local Pod discovery

This repairs approved improvement 01's local discovery path. Remote HTTPS access,
verified-origin enrollment and physical iPhone acceptance remain separate work.

## Failure and repair

On 12 November 2026, the working Pod moved from its saved DHCP address to a new
address. The previously trusted SSH host key verified the same physical controller.
Its HTTP server was healthy, but no Avahi service was installed. The old discovery
module treated the absence of `/etc/avahi` as development mode and skipped publishing.
It also logged success when reloading a stopped Avahi daemon failed.

Core now checks for an actual Avahi process and a usable service file. Otherwise,
`@homebridge/ciao` publishes `_sleepypod._tcp`, with the HTTP port, `wsPort`, protocol
version and the system hostname. Ciao is already a locked dependency of the HomeKit
bridge. The fallback resolves it from the installed `hap-nodejs` package, so both
consumers use the same reference-counted responder. This retains the existing
dependency lock and biometric manifest identity instead of invalidating saved
numerical profiles for an unrelated discovery change.

This uses ciao's DNS-SD responder and network-interface monitoring rather than
sending one announcement and assuming clients can resolve it later. See the
[upstream implementation and lifecycle documentation](https://github.com/homebridge/ciao).

## Lifecycle and authentication

- Startup is idempotent across instrumentation/module copies through `globalThis`.
- A missing daemon, read-only filesystem or failed Avahi reload uses the fallback.
- HTTP/WebSocket ports are validated before publication or XML generation.
- Failed startup releases resources and retries after 30 seconds. Development/test
  processes do not advertise by default; `SLEEPYPOD_MDNS=1` opts in and `0` opts out.
- Shutdown cancels delayed startup/retry, withdraws this service, and releases only
  its responder reference. It does not shut down another HomeKit consumer's reference.
- A restart waits for previous withdrawals, including a cancelled queued restart.
- Discovery failures are logged and do not stop hardware services or local routines.
- DNS-SD contains no connection keys, account identity or personal data. Discovery is
  an untrusted address hint; it does not enroll an origin, authenticate a controller,
  grant a caller access or relax the native app's existing connection policy.

## Validation

The 29 lifecycle tests cover missing/stopped Avahi, configured and invalid ports,
read-only files, stale installer configuration, failed reload, duplicate module
imports, publication cancellation, repeated Stop/restart races, failed resource
creation/withdrawal, automatic retry and cancellation of retry.
An additional real-module test verifies that the loader returns HomeKit's installed
ciao instance without starting a responder. The combined discovery, biometric
manifest and schedule-rollback suites pass 76 tests.

TypeScript and targeted lint pass. The production Next build passes with the ciao
runtime dependency included in its standalone output. Normal pre-push and hosted
checks remain required before merge. The initial hosted run caught the direct
dependency's changed lock hash and a schedule-rollback timeout. The dependency
change was removed; the exact rollback test passed locally without changing its
assertions or timeout. The failed hosted run is retained, and the corrected release
must pass the full hosted suite before it is merged or activated.

A bundled copy of the initial discovery module ran as a separate **45-second probe**
on the Pod, after checking the existing loopback web server. Its SHA-256 was verified
before execution. The probe used the controller's Node 24 runtime and did not load
hardware, database, scheduler, MQTT or HomeKit controller modules.

Observed from this Mac during the probe:

- `_sleepypod._tcp.local` browsing returned `sleepypod`.
- Service resolution returned `eight-pod.local:3000`, `wsPort=3001`, `version=1.0.0`.
- Hostname resolution returned the Pod's new LAN address.
- HTTP through `eight-pod.local:3000/en` returned 200.
- The probe exited successfully after cleanup. The actual controller remained active
  with the same PID and old release directory throughout.

Private diagnostic receipts: `/tmp/sleepypod-discovery-dns-sd.txt`,
`/tmp/sleepypod-discovery-pod-probe.log`, and `/tmp/sleepypod-discovery-build.log`.
This bounded probe is **not a permanent deployment**. Normal release installation
and an actual iPhone network-transition check remain necessary. A stable local name
also does not provide access from outside the home.
