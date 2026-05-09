# ADR 0020: Deterministic HomeKit identity derivation

## Context

The embedded hap-nodejs bridge (ADR-adjacent: `feat/homekit-bridge`,
`src/homekit/`) exposes the Pod as a HomeKit accessory. HAP requires three
pieces of identity that, once published, key everything iOS does with the
device:

- `username` — 6 bytes formatted as a locally-administered MAC. Used by iOS
  as the stable accessory ID.
- `pincode` — 8-digit setup code embedded in the QR; user enters it (or
  scans it) once during pairing.
- `setupId` — 4 chars, mixed into the setup URI alongside the pincode.

Today these are generated with `randomBytes` on first run and persisted to
`/persistent/sleepypod-data/homekit/identity.json` (`src/homekit/storage.ts`).
Loss of that file is catastrophic for the user: iOS sees a brand-new
accessory, every Home automation, scene, and room assignment wired to the
old bridge becomes orphaned, and the user has to delete + re-add the device
and rebuild their Home setup from scratch.

This is distinct from losing pairing state (`AccessoryInfo.<USERNAME>.json`,
`IdentifierCache.<USERNAME>.json`), which only forces a re-pair from the QR
code while leaving automations intact. **Identity loss is the load-bearing
durability problem; pairing loss is recoverable.**

`/persistent` is the only line of defense today. Wipe scenarios that
matter:

- Factory reset / firmware reflash.
- `/persistent` filesystem corruption (rare but observed on long-running
  pods).
- Operator manually clears `/persistent/sleepypod-data/` while debugging.
- pod-to-pod identity migration (RMA, hardware upgrade) — not strictly a
  wipe, but identity should follow the *user*, not the storage chip.

A DB-on-pod approach was considered (move identity into a `homekit_identity`
table). Rejected because the SQLite file lives in the same `/persistent`
directory; both share fate. DB consolidation is a separate tidiness change,
not a durability one.

An off-pod replication approach (mirror identity over MQTT or to a cloud
endpoint) was considered. Rejected as default for two reasons: it imposes a
network dependency on a feature that should work fully offline, and the HA
MQTT path (ADR 0019) is opt-in — most users never enable a broker.

## Decision

**Derive HomeKit identity deterministically from a chained set of
hardware-rooted seeds via HKDF. Continue persisting the resolved identity
to `identity.json` as a cache, not as the source of truth.**

### Seed chain

Read in order; first usable value wins. Record the source in
`identity.json` so operators can debug downgrades.

| order | source                                  | rationale                                    |
|-------|-----------------------------------------|----------------------------------------------|
| 1     | `/sys/block/mmcblk0/device/cid`         | eMMC chip serial; survives reflash; tied to physical pod |
| 2     | `/sys/block/mmcblk0/device/serial`      | alternate kernel exposure on some mmc subsystem builds |
| 3     | `/etc/machine-id`                       | systemd machine identifier; survives reboot but not factory reset |
| 4     | random bytes persisted to `identity.json` (current behavior) | dev fallback and last-ditch for pods where 1–3 all fail |

A seed is "usable" iff it is non-empty and not all-zero / all-FF. Vendor
firmware on some early-gen eMMC modules ships those degenerate values;
silently deriving from them would collide identities across pods.

The seed source is **not** assumed universal. Pod 3 (Yocto, kernel 4.x),
Pod 4 (Yocto, kernel 5.x), and Pod 5 (Debian) build the mmc driver
differently; CID exposure under sysfs is build-time-configurable and not
guaranteed. The chain degrades to `machine-id` and finally to the current
random-with-disk-cache behavior, so no pod regresses below today's
durability.

### Derivation

```ts
import { hkdfSync } from 'node:crypto'

function derive(seed: string, label: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', seed, /* salt */ 'sleepypod-homekit-v1', label, length))
}

const macBytes = derive(seed, 'username', 6)
macBytes[0] = (macBytes[0] & 0xFE) | 0x02   // locally-administered bit
const username = formatMac(macBytes)
const pincode  = formatPin(derive(seed, 'pincode', 4))   // reject HomeKit-banned codes; loop with derive(seed, `pincode/${i}`, 4)
const setupId  = formatSetupId(derive(seed, 'setupid', 4))
```

The salt `sleepypod-homekit-v1` is fixed and version-pinned. Bumping it to
`v2` is the documented escape hatch if a derivation bug ships and pods need
new identities without changing the seed source.

The pincode generator must reject HomeKit's banned set
(`000-00-000`…`999-99-999` repeats, `123-45-678`, `876-54-321`). Implementation
loops with `derive(seed, 'pincode/' + attempt, 4)` until a valid code is
produced; bounded retry budget so a degenerate seed can't infinite-loop.

### Cache file

`identity.json` continues to exist with one new field:

```json
{
  "username": "AA:BB:CC:DD:EE:FF",
  "pincode":  "123-45-678",
  "setupId":  "ABCD",
  "derivedFrom": "mmc-cid",
  "derivedAt": 1746500000
}
```

On startup:

1. If `identity.json` is present **and** parseable → use it. (Hot path; no
   sysfs reads on every server start.)
2. Else read the seed chain, derive, write `identity.json`.

`regenerateIdentity()` is preserved for the "user wants a fresh pairing"
case in Settings: it bumps the salt with a per-identity counter (also
written into `identity.json`) so derivation produces a new ID without
needing a new seed.

### Diagnostics endpoint

Add `homekit.seedProbe` to the HomeKit tRPC router (HTTP `GET /homekit/seed-probe`) — a read-only query
that returns the seed source resolution chain (`mmc-cid` → present /
absent / unreadable / degenerate) for every pod variant. Operators run it
once per pod fleet to confirm assumptions before relying on the durability
claim. No identity material is exposed; only "which source the chain would
pick on this pod."

## Consequences

**What this gets us.**

- `/persistent` wipe → identity regenerates **identically** → iOS recognizes
  the bridge → user only has to re-pair (scan QR), automations stay intact.
- Reflash / sp-update / factory reset → same.
- Pod replacement → identity changes (different hardware) — correct
  semantics; it is a different device.
- No new table, no migration, no MQTT or cloud dependency. Works offline.

**What this does not get us.**

- Pod-to-pod identity migration (RMA) — the new pod has a different seed,
  so the user must re-add. This is intentional; cross-device identity
  transfer is a separate problem (would need cloud or USB export).
- Pairing-state survival across `/persistent` wipe. Re-pair is still
  required. Mirroring `AccessoryInfo.json` to the DB or to MQTT is a
  follow-up if user feedback warrants it.
- Resistance to a malicious actor who reads the eMMC CID and computes the
  pincode. CID is a chip serial, not a secret. A LAN attacker who can read
  `/sys/block/mmcblk0/device/cid` can already root the pod; HomeKit
  pincode confidentiality on top of that is not a meaningful boundary.

**Migration path for existing pods.**

Pods that already have a `randomBytes`-generated `identity.json` keep it.
The deterministic chain only fires on **first run** or **after
`identity.json` is missing**. Existing identities are not rotated under us;
that would force a Home app re-add for every user on upgrade, which is
unacceptable. The durability win lands the next time `/persistent` is
wiped, not retroactively.

## Implementation notes

- Single `readSeed()` helper in `src/homekit/storage.ts`; everything else
  derives from its return value. Tests mock `readSeed()` to cover all
  four chain tiers including degenerate-seed rejection.
- `hkdfSync` from `node:crypto` (no new dep).
- Salt constant lives at the top of `storage.ts` as
  `const HKDF_SALT = 'sleepypod-homekit-v1'`. Document at the call site
  that bumping it changes everyone's identity.
- The `homekit.seedProbe` tRPC route reads each path with
  `fs.access` + `fs.readFile`; no shell-out, no privileged caps. Returns
  `{ source, present, readable, looksDegenerate }` per chain entry plus
  the resolved choice.
- Logs at startup print only `derivedFrom` and `username`; never the
  pincode or setupId.
- File mode stays `0600`; only the `dac` user reads it.

## Refs

- HomeKit bridge: `src/homekit/`, `src/homekit/storage.ts:46`
- Pod variants: `src/hardware/pods.ts` (H00 / I00 / J00)
- Tasks: sleepypod-core-34 (verification), sleepypod-core-35 (mDNS)
- Related: ADR 0019 (MQTT bridge — alternative durability transport,
  rejected as default)
