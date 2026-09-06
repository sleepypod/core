# Pod web-service measurements — 2026-09-06 UTC

Measured on Pod `192.168.1.88` (aarch64, approximately 2 GiB RAM, Node
22.17.0, Next.js 16.3.3). The previous installation was `e2c45c8`; the
performance changes were first deployed as `40fab93`, then the coverage
cleanup was deployed as `38e0695`. Package and lockfile hashes matched the
previous installation, allowing its ARM-native dependencies to be reused.

## Results

The settled final build reduced median status latency from **99.43 to
40.06 ms (60%)**, concurrent status p95 from **366.33 to 121.57 ms (67%)**,
and diagnostics initial JavaScript from **1,279,395 to 783,209 decoded bytes
(39%)**. Next.js remains in use.

| Metric | Before (`e2c45c8`) | Final, settled (`38e0695`) |
| --- | ---: | ---: |
| Status median (60 requests) | 99.43 ms | 40.06 ms |
| Status p95 | 106.52 ms | 45.94 ms |
| Status maximum | 143.69 ms | 51.28 ms |
| Four concurrent status reads: median (48 requests) | 246.64 ms | 82.04 ms |
| Four concurrent status reads: p95 | 366.33 ms | 121.57 ms |
| Health probe during those bursts: median (12 requests) | 96.05 ms | 131.78 ms |
| CPU during 2 Hz status reads (% of one core) | 25.18 % | 20.25 % |
| Idle CPU (% of one core) | 13.52 % | 13.65 % |
| RSS at end of serial status phase | 178.15 MiB | 186.34 MiB |
| Temperature page HTML median (10 requests) | 44.44 ms | 45.4 ms |
| Diagnostics HTML median (10 requests) | 35.02 ms | 34.13 ms |
| Diagnostics initial JavaScript | 1,279,395 bytes | 783,209 bytes |
| Diagnostics initial script count | 16  | 12  |

CPU during the status polling phase was about 20% lower in the settled final
run. Idle CPU and HTML response medians were broadly unchanged; these data
do not demonstrate a memory reduction. The lightweight health request
issued alongside each status burst became slower (96.05 to 131.78 ms median),
so this is not an improvement across every endpoint under contention.

Raw measurements: [baseline](web-service-2026-09-06/before.json),
[initial performance build](web-service-2026-09-06/initial-after.json),
[initial build after warming](web-service-2026-09-06/warm-after.json),
[final build including startup](web-service-2026-09-06/final-after.json), and
[final settled build](web-service-2026-09-06/final-warm-after.json). The two
initial performance runs had median status times of 44.36 and 39.11 ms.
The final settled run's WebSocket status frames continued approximately
once per second (1,035.98 ms p95 gap).


## Method

The [benchmark script](web-service-2026-09-06/benchmark.mjs) runs on the Pod
against `http://127.0.0.1:3000`. Times include receipt of the complete HTTP
response. These measurements exclude Wi-Fi round trips and browser parsing,
hydration, painting, and interaction latency.

Each run samples 15 seconds without its own WebSocket, then connects one
read-only `deviceStatus` subscription on port 3001. After three warmup reads,
it makes 60 serial `device.getStatus` tRPC requests, at least 500 ms apart
start-to-start. Next come 12 bursts, each containing four concurrent status
requests plus one `health/dac-monitor` request. This keeps the hardware
monitor in its normal active-client polling mode while measuring reads.

Each page receives one warmup and ten timed HTML requests. The script then
fetches the distinct JavaScript URLs in the HTML's script elements. The byte
counts are decoded source bytes, including the polyfill script; they are
neither compressed transfer bytes nor all the code that later navigation
might load. Asset-fetch duration is a loopback HTTP measurement, not page
rendering time. Settings receive 20 additional serial reads.

CPU is the change in the web server process's user/system ticks from
`/proc/PID/stat`; `SC_CLK_TCK=100` was verified on this Pod. Percentages refer
to one CPU core. RSS comes from `/proc/PID/status`, not the systemd cgroup's
memory total. Background processing and normal app services stay active.

The initial post-deployment run includes startup activity in its idle sample;
the second run of `40fab93` checks behavior after warming. Two final complete
runs verify the deployed coverage cleanup, including a run after sensor
startup completed. One baseline and these short
post-deployment runs cannot establish long-term resource use or isolate every
source of variation. Deployment also moved the application to `/persistent`
because root had only 141 MB free; its dependencies remain in their previous
location.

The first `38e0695` run included a 723.48 ms status request around
00:36:12 UTC. At that time the journal recorded `no NATS server after 60s`
and the switch to RAW-file input. This is a temporal correlation, not a
profile proving causation. The sample is retained in
[final-after.json](web-service-2026-09-06/final-after.json); it is not removed
from that run's statistics. The additional settled run separates this startup
phase from ordinary polling. No NATS configuration or sensor service was
changed to improve the benchmark.

## Reproduce

Copy the benchmark to the Pod, close test browser tabs, and wait for
`/api/health/dac-monitor` to report `running`. On this Pod, run:

```sh
/usr/local/bin/node benchmark.mjs http://127.0.0.1:3000 sample /persistent/sample.json
```

Use Node 22 or newer. The script reads the `sleepypod` systemd service's PID
and assumes Linux with 100 clock ticks per second for its CPU calculation.
Keep the existing services and workload consistent between runs. It performs
HTTP queries and a sensor subscription; it does not send temperature, power,
or other control commands.

## Deployment and verification

The exact successful push-workflow artifacts were used: [initial build
33994517223](https://github.com/sleepypod/core/actions/runs/33994517223) and
[coverage follow-up 34001504070](https://github.com/sleepypod/core/actions/runs/34001504070).
Build caches were omitted from deployment. The current application path
points to `/persistent/sleepypod-releases/38e0695`; the original installation
is retained at `/home/dac/sleepypod-core.before-web-perf-40fab93` and supplies
the shared `node_modules`. Keep that directory while either release depends
on it. The previous performance release remains available at
`/persistent/sleepypod-releases/40fab93`.

The database paths, service configuration, and environment were preserved.
Only the web service was restarted. Hardware reconnected, all 356 scheduled
jobs loaded, and frank plus all five biometrics/sensor sidecars stayed active.
System health reported an intact firewall and no schedule drift. The live
browser smoke check loaded Overview, Thermal, Biometrics, and Sensors; the
deferred charts rendered, live sensors updated, and no browser console
errors appeared. That browser check used `40fab93`; the follow-up only
simplifies equivalent server cache branches and adds regression coverage.

The subagent reproduced the Codecov findings, removed a redundant outer
Wi-Fi catch (all probe helpers already catch failures), and consolidated the
status fallback into one branch so V8 records it correctly. It also added a
regression test for requests before the monitor starts. The focused suite
passed 125 tests; Wi-Fi coverage and device-router branch coverage both
reached 100%. The [linked Codecov
report](https://github.com/sleepypod/core/pull/693#issuecomment-5555069198)
now reports all modified, coverable lines covered. CI tests, lint,
TypeScript, both production builds, and local pre-push gates passed for
`38e0695`.
