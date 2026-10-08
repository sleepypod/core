# free-sleep adjustable-base investigation

Inspected 2026-10-04 using a full Git clone, not the stale base README.

## Reproducible comparison

- beta: `a35972d839a68a1a7a78c57085edf7a5a4be314d`
- main: `2e5922c3c0f61a7a2ee73225a752aab4e2990dc4`
- merge base: `4beeb7dcc9e7058e650e3822c54ebaac2bdcbc61` (2025-07-21).
- sleepypod starting point: `0348650a7af63f66ffec2a7f3bf4160702efd65d` (`origin/dev`).

Use `git diff main...beta -- server/src/8sleep server/src/routes/baseControl server/src/jobs/baseScheduler.ts app/src/routes/base-control.tsx` with the pinned refs above. Today's main contains no base controller, presets, or base scheduler. The first base UI commit's parent is `36784864c0b35f6fcf339516cb8944aae1ee13ae`. Comparing that parent with the base series isolates the feature from beta's unrelated changes. The main ancestor before July 5 was `a26a32b2ce205953cae1c7c95a92d49968dc3b10`; the common ancestor is the more reliable branch comparison. Historical branch pointers are not retained by Git, so this is ancestry evidence, not a claim about an exact historical main tip.

## History

Dates below are author dates. The July 5–13 commits were committed/replayed July 22; using only commit dates hides their original sequence.

| Commit | Author date | Change |
| --- | --- | --- |
| [4dd24e3](https://github.com/throwaway31265/free-sleep/commit/4dd24e306e982f7a84e8839291566f0698b4a690) | July 5, 2025 | Base UI scaffold |
| d196560 | July 5 | API/state simulation and UI wiring |
| [74d6439](https://github.com/throwaway31265/free-sleep/commit/74d6439c0fffbd634e3b84ec054cb52d741eddab) | July 5 | Actual TriMix BLE controller, command generator and Bluetooth guide |
| fccb791 | July 5 | Nonlinear tick maps and packet format |
| 1d1d3e1 / b85f164 | July 5 | Stop and notification checksum validation |
| c17cb08 / 5ef7dce | July 6 | Presets; final flat/sleep/relax/read values |
| 51fe329 | July 6 | Scheduled elevations |
| 5b924b7 / 62c2b71 | July 13 | Already-connected handling and addressed info request |
| 1384c40 | August 15 | Gate scheduled elevations on enabled power schedule |
| 5e79e21 | August 23 | Configuration retries and configured status |

## Actual beta contract

[Controller at pinned beta](https://github.com/throwaway31265/free-sleep/blob/a35972d839a68a1a7a78c57085edf7a5a4be314d/server/src/8sleep/trimixBaseControl.ts)

- Separate BLE transport, not a DAC command. Persistent `bluetoothctl` process.
- Reads `/persistent/AdjustableBaseConfiguration.json`: `Address` MAC and `SplitBase` boolean. SplitBase is never used. Commands select synchronized torso motor 6 and leg motor 5; independent sides are **not** implemented.
- BlueZ hci0 device paths: `service0008/char0009` notifications (FFE1), `service0008/char000f` writes (FFE3). The old README incorrectly calls FFE1 the write characteristic and still claims simulation.
- Position: 18-byte payload plus 16-bit additive little-endian checksum. Header `ff ff ff ff 01 00 21 14`; rate at byte 8; motor at 9; little-endian ticks at 10. Range: head 0–60°, feet 0–45°, rate 30–100 (default 50).
- Stop: `ff ff ff ff 05 00 00 00 00 d7 00 d8 04` (13 bytes).
- Position notifications: 20 bytes with same checksum; type 0x22; left leg/torso ticks at offsets 9/11, right at 13/15. Upstream averages ticks before converting. Motion is inferred from position changes, not confirmed by a decoded motor flag.
- Preserve lookup tables exactly: torso discontinuities at 20° and 60°, legs non-monotonic at 15° and 20°. No evidence justifies replacing them with linear interpolation.
- Presets `(head, feet, rate)`: flat `(0,0,50)`, sleep `(1,5,50)`, relax `(30,15,50)`, read `(40,0,50)`. UI's relax caption says 25/10 although controller uses 30/15.
- API: status, position, preset, stop. UI provides position adjustment, presets, stop, bed illustration.
- Elevation schedules use timezone/day rollover and away mode. Although stored per side, every callback moves the entire bed; two side schedules can conflict.

## Adaptation decisions and gaps

Do not port Express, lowdb, Zustand, MUI, the old scheduler, or the duplicated raster bed images. Use sleepypod tRPC/OpenAPI, Drizzle, JobManager, React design tokens, and a small SVG illustration. Preserve upstream MIT attribution for protocol tables.

Fix unacknowledged stdin writes, stdout chunk parsing, ASCII-column contamination, unbounded retries/buffers, process error handling, stale connection state and automatic command replay. Stop must invalidate pending movement, including the second motor write after the 500 ms delay. No artificial zero position or success on disconnection. Keep left/right telemetry visible; whole-bed control is explicit. Do not advertise independent split-base positioning.

Hardware qualification remains separate from software verification: exact BlueZ transcript/prompt behavior, firmware variant handles, table calibration and physical stopping require a configured TriMix base. There is no attached base available in the development environment. Protocol examples are upstream evidence, not newly observed physical tests.

See [ADR 0024](../adr/0024-adjustable-base-control.md) for the sleepypod design and validation contract.

## Transport follow-up

[BlueZ 5.50 client/gatt.c](https://github.com/bluez/bluez/blob/5.50/client/gatt.c) `write_reply` only prints errors in interactive mode. It cannot provide a reliable positive write acknowledgement. sleepypod therefore uses BlueZ's [GattCharacteristic1 API](https://github.com/bluez/bluez/blob/master/doc/org.bluez.GattCharacteristic.rst) through dbus-next, with explicit request writes and PropertiesChanged notifications. Characteristic UUIDs come from the pinned beta Bluetooth guide (FFE1 notify, FFE3 write), not its obsolete README. This also removes CLI chunk/prompt parsing and hardcoded service handles. The configured device must already be paired; interactive PIN prompting is left to stock setup.
