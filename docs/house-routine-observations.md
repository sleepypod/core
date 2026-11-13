# House Control presence bridge

`GET /api/v1/house-routine/observations` supplies the existing House Control Daily
Rhythm v1 adapter with one logical Left bed observation. It is read-only and uses
normal owner authentication. No bed, light, audio, schedule or base action is
enabled by providing this endpoint.

## Admission and meaning

- The current supported arrangement is `solo-left` with the other zone following.
  The logical sleeper can occupy either physical zone or the middle. Both fresh
  calibrated zones must establish absence before `whole_bed_empty` can be true.
- Current calibration, Pod hardware, build, routine and policy must match the
  latest confirmed empty and occupied attended checks. A retest request, changed
  identity, malformed record or unavailable mechanical state withdraws output.
- A movement aggregate alone is insufficient. Presence must include the original
  calibrated capacitance measurement and its source key; timestamps more than
  30 seconds old or in the future are rejected. Repeated polling preserves the
  measurement timestamp and expiry.
- `qualified` means those presence checks match. It does **not** qualify base
  movement, prove sleep, identify a person, or validate an automation outcome.
- Shared-person privacy remains closed. After the household privacy boundary is
  established, an owner key cannot fetch this endpoint. Shared-bed export needs
  its own consent and personal identity contract before it can be implemented.
- A right-side logical sleeper or dual arrangement is not silently remapped to
  Left. The delivered House Control v1 client requires Left explicitly.

Successful responses contain `version: 1` and one `observations` entry with
`signal: "bed"`, `side: "left"`, `value: "occupied" | "empty"`, the unchanged
`measured_at`, an opaque source revision and `qualified: true`. Fields include
`whole_bed_empty`, `presence_scope`, qualification basis, calibration hash and
`expires_at`. Private notes, vitals and sleep estimates are excluded.

Unavailable or unqualified input returns HTTP 503; unknown parameters return
400, unauthorized access 401 and a personal privacy boundary 403. Responses are
private/noncacheable, including access rechecks after reads and before delivery.

## House Control cutover

The adapter is in `core/Sources/HouseCore/DailyRoutine/DailySleepypodBridge.swift`
in House Control. Its `bindings.sleepypod_observations_qualified` flag stays false
until the deployed response and actual occupied/empty behavior are attended and
verified. Its existing 120-second entry and 30-second exit dwell checks remain
necessary. Do not set that flag from successful unit tests.

Movement and Stop coordination endpoints remain separate work. This endpoint
does not turn the proposed `/movement` or `/stop` handoff into supported routes.
Existing native/physical Stop and current routines remain the control authority.
