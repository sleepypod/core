# ADR 0026: S3-compatible archive push

**Status:** Proposed — plan for review. Only the AWS Terraform (`deploy/aws-archive-bucket/`) lands with this ADR.
**Date:** 2026-11-22

## Context

A pod keeps a few weeks of history at most:

- The pruner drops the oldest `*.RAW.gz` once `/persistent` passes 80%
  ([ADR 0018](0018-tmpfs-raw-frames.md)).
- One Pod 4 on 2026-11-16 had 6.7 GB of RAW archive covering 26.9 days, on a
  15.5 GB eMMC that was 76% full.
- Its off-pod copy grows by about 1.8 GB of `.RAW.gz` a week. That's about
  250 MB a day, or 90 GB a year.

Every night with Apple Watch data is a labelled night for tuning biometrics, so
a pod that prunes them throws away training data.

Two ways to keep history off the pod already exist:

- **`modules/archive-push`** (sp-21) pushes nightly to a host the user runs,
  over scp. The host needs ssh and an `authorized_keys` entry.
- **`scripts/biometrics-archive`** pulls the analysis export onto a laptop or NAS.

Both assume an always-on machine on the LAN. Most owners don't have a NAS. A
bucket at a storage provider is the place they'd actually use.

**This isn't an eMMC-wear fix.** ADR 0018 already moved live RAW writes to
tmpfs. What remains is one gzip write per 15-minute frame, and an upload after
that write saves nothing. The cloud buys retention and an off-site copy, not
flash life.

## Decision

1. **Add `TRANSPORT=s3` to archive push.** The S3 API is the contract and the
   provider is the user's choice: AWS, Cloudflare R2, Backblaze B2, or MinIO on
   a NAS. One uploader serves all of them. Settings take an endpoint, region,
   bucket, prefix and key pair. `TRANSPORT=ssh` stays the default and its
   behaviour doesn't change.
2. **Retention belongs to the bucket, never the pod.** The pod never deletes or
   overwrites remote objects. The pod key needs only list and create, so a leaked
   key can't read or erase history. Lifecycle rules on the bucket expire and
   tier data.
3. **Ship a Terraform root for AWS** (`deploy/aws-archive-bucket/`). It builds
   the bucket and least-privilege keys correctly the first time. Other
   providers get written steps against the same contract.

### Bucket layout

```
<prefix>raw/<seqno>.RAW.gz              # same names as /persistent/biometrics-archive
<prefix>db/biometrics-<UTC stamp>.db.gz # nightly online backup, as the ssh transport makes today
<prefix>probe/<UTC stamp>.txt           # Test button; expired by lifecycle
```

`<prefix>` is per pod. The Terraform uses `<pod name>/`. Putting the pod first
lets one bucket hold several pods, each key scoped to its own prefix, and gives
lifecycle rules a literal prefix per data kind.

## Pod-side design

### Configuration and secrets

- `archive-push.conf` gains `TRANSPORT`, `S3_ENDPOINT`, `S3_REGION`,
  `S3_BUCKET`, `S3_PREFIX`, `S3_ACCESS_KEY_ID` and `S3_PATH_STYLE`. These are
  plain `KEY=VALUE` lines, still read without `source`. The router's
  `SAFE_STRING` and `KNOWN_KEYS` whitelists extend to them.
- **The secret key goes in its own file**,
  `/etc/sleepypod/archive-push.s3-secret`. It is mode `0600` and owned by
  `sleepypod`, the user the push service runs as.
- **The settings API never returns the secret.**
  - `getConfig` reports `hasSecret: boolean`.
  - `setConfig` takes an optional `secretAccessKey` that it writes and never echoes back.
  - The UI shows "Saved" with a **Replace** button, like a password field.
- The API is LAN-trusted and has no auth (`src/server/openapi.ts`).
  Re-pointing the push at another bucket adds no new exposure: anyone on the
  LAN can already read the same data from `/api/biometrics/analysis-export`.
  But a secret the UI echoed back could leave the LAN and be reused from
  anywhere. That's why the field is write-only.

### Uploader

`modules/archive-push/sleepypod-archive-push-s3.mjs` runs on the Node that
already does the database backup (`$NODE_BIN`, `/usr/local/bin/node`).
`sleepypod-archive-push` hands off to it when `TRANSPORT=s3`. It has **no npm
dependencies**:

- It uses global `fetch` plus a SigV4 signer (about 100 lines on `node:crypto`).
  The signer is tested against AWS's published SigV4 test vectors.
- The AWS SDK is several megabytes of packages for three calls.
- `curl --aws-sigv4` depends on a curl build that isn't confirmed on every pod
  generation. See [Open questions](#open-questions).

**What one run does:**

1. **List.** `ListObjectsV2` on `<prefix>raw/`, paginated, into a set of names.
   This is one diff pass, as the ssh transport does with `ls -1`.
2. **Upload.** For each local `*.RAW.gz` the bucket doesn't have, send a single
   `PUT`:
   - `x-amz-content-sha256` carries the real payload hash, not
     `UNSIGNED-PAYLOAD`, so the provider rejects a corrupted body.
   - `If-None-Match: *` makes the write create-only. A `412` means the object
     already exists, and counts as skipped.
   - Providers that ignore the header just rewrite identical bytes.
   - Files are a few MB each and the database snapshot is tens of MB, so
     single PUTs are enough; there's no multipart.
3. **Database snapshot.** Make one with the existing `better-sqlite3` online
   backup, gzip it, and `PUT` it to `<prefix>db/`, also create-only.
4. **Status.** Write the run's result to `archive-push-status.json` beside
   `DATABASE_URL`: counts, the last error, and the oldest local file not yet
   uploaded. Settings → Backup and `sp-status` read this file.

**Path style.** Virtual-hosted addressing (`bucket.endpoint`) is the default.
`S3_PATH_STYLE=true` switches to `endpoint/bucket`, which MinIO and some NAS
gateways need.

**Test button.** The ssh `testConnection` has an S3 counterpart, which runs:

- a `ListObjectsV2` on the prefix,
- one create-only `PUT` to `<prefix>probe/`.

These are the two permissions a push needs. It reports each one separately, so
"can list, can't write" is distinguishable from bad credentials or a wrong
region.

### Network: the WAN block

By default `internet-control` drops all non-LAN outbound traffic. How each
destination gets through:

| Destination | What happens |
|---|---|
| LAN endpoint (MinIO, NAS) | Allowed today; nothing changes |
| Internet allowed by the owner | Allowed today; nothing changes |
| Public endpoint while blocked | Needs a **push window** |

How the push window works:

1. **Open.** A root `ExecStartPre=+` runs `internet-control archive-egress open`.
   It reads `S3_ENDPOINT` from the conf, validated as an `https://` URL,
   resolves its A records and adds those addresses to a dedicated
   `SLEEPYPOD-ARCHIVE-EGRESS` chain. Only TCP port 443 is allowed. The chain is
   jumped from `SLEEPYPOD-BLOCK` ahead of the `DROP`.
2. **Upload.** The resolved addresses go into `/run/sleepypod/archive-egress.ips`.
   The uploader pins its DNS lookups to that list, so a fresh resolve can't
   pick an address the window doesn't allow.
3. **Close.** `ExecStopPost=+` runs `internet-control archive-egress close`,
   which flushes the chain. Because `ExecStopPost` runs after a failure too,
   the chain is also flushed when the upload fails.

The `*.8slp.net` NXDOMAIN layer stays up throughout. IPv6 isn't opened.

### Pruner interaction

The pruner keeps deleting the oldest local file at 80%, whether or not that
file has been uploaded. The ssh transport behaves the same way today. A push
that fails for weeks would therefore lose files before they upload.

- **In this plan:** the status file reports the oldest unpushed file, and the
  UI warns when the pruner is getting close to it.
- **Deferred:** a pruner that knows what's been pushed. It trades a full disk
  for data, and needs its own design.

### NATS firmware

Pods on NATS firmware write no `*.RAW` files (ADR 0018, sleepypod-core-54), so
there is no RAW archive to push. Database snapshots still push. RAW starts
pushing once a NATS consumer writes the same cold archive.

## Least-privilege contract

What any provider's key must allow, and nothing more:

| Need | AWS action | Why |
|---|---|---|
| List own prefix | `s3:ListBucket` with `s3:prefix` = `<prefix>*` | Diff against what's already uploaded |
| Create under own prefix | `s3:PutObject` on `<prefix>*` | Upload |
| — | no `GetObject`, `DeleteObject` or other prefixes | A leaked pod key can't read or erase history |

How each provider meets it:

| Provider | Endpoint | Key setup | Retention |
|---|---|---|---|
| AWS | `https://s3.<region>.amazonaws.com` | `deploy/aws-archive-bucket/` | Lifecycle in the Terraform |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com`, region `auto` | API token, Object Read & Write, scoped to the bucket (R2 can't scope a token to a prefix or make it write-only) | R2 lifecycle rules in the dashboard |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | Application key restricted to the bucket and `namePrefix`, with `listFiles` and `writeFiles` only | B2 lifecycle settings |
| MinIO / NAS | LAN URL, `S3_PATH_STYLE=true` | User policy with the same two actions on the prefix | `mc ilm` rules |

R2's token is broader than the contract. The docs will say so, and suggest one
bucket per pod there.

## AWS Terraform (`deploy/aws-archive-bucket/`)

Lands with this ADR. The bucket:

- blocks public access, disables ACLs, encrypts with SSE-S3 and refuses
  plain HTTP;
- is versioned, with a governance-mode Object Lock (`object_lock_days`, 30);
- has `force_destroy = false`.

Lifecycle:

- `raw/` moves to Glacier IR after 30 days and is kept forever.
- `db/` expires at 90 days.
- `probe/` expires at 1 day.
- Noncurrent versions expire at 30 days, and incomplete uploads at 1 day.

Keys and extras:

- One IAM user and key per pod, under the contract above, plus a `DenyOverwrite`
  statement: a `PutObject` without `If-None-Match` is refused.
- An optional source-IP condition, a read-only restore user and a budget email.
- Secrets come out as sensitive outputs. The README covers local state, rotation
  with `-replace`, and `create_access_keys = false` for owners who'd rather make
  keys by hand.
- CI runs `terraform fmt -check` and `terraform validate` on changes under `deploy/`.

## Cost (90 GB/year RAW + nightly DB)

| Provider | Storage at end of year 1 | Reading it all back once |
|---|---|---|
| AWS (defaults: Glacier IR after 30 d) | ~$0.50–1/mo | ~$2.50 retrieval; the first 100 GB/mo out is free |
| AWS, all STANDARD | ~$2.30/mo | free under 100 GB/mo |
| Cloudflare R2 | ~$1.40/mo (first 10 GB free) | free |
| Backblaze B2 | ~$0.60–0.70/mo | free up to 3× stored |
| MinIO / NAS | your disk | LAN |

These are list prices as of this ADR. The pod uploads about 90 objects a day,
which costs cents a month in request fees. Transfer into every provider above
is free.

## Privacy

`docs/PRIVACY.md` says no data leaves the local network. An opt-in push to a
destination the owner configures needs that wording updated in the same PR as
the UI. For example: "unless you configure Backup to send it to a storage
destination you control".

- Data is encrypted in transit (TLS; the Terraform refuses plain HTTP) and at
  rest (provider SSE).
- Client-side encryption, so the provider never sees plaintext, is an open
  question. It would change the restore path.

## Alternatives considered

- **AWS SDK v3 on the pod.** Correct, but several MB of dependencies for
  `ListObjectsV2` and `PutObject`.
- **`rclone`.** Supports every provider, but it's a ~60 MB static binary the
  pod would have to download and keep updated. There's no package manager.
- **Pod key with delete rights, retention in the app.** This is the seedypod
  pattern before its lifecycle fix. A compromised LAN or a leaked key could
  wipe the off-site copy, the one thing a backup is for. Rejected.
- **Upload straight from tmpfs and skip the eMMC gzip write.** It would save
  one sequential write per frame. But it needs the network up whenever a frame
  closes, and a disk fallback anyway, which puts the write back. Not worth it
  (see Context).
- **Relay through the owner's Mac** (pull, then sync to the bucket). That
  already works with `scripts/biometrics-archive` and any sync tool. It isn't a
  path for owners without an always-on machine.

## Implementation plan

Each step is a separate PR into `dev`:

1. **This PR:** the ADR, `deploy/aws-archive-bucket/`, and a CI `terraform validate`.
2. **Uploader:**
   - `sleepypod-archive-push-s3.mjs` with SigV4, list, create-only PUT,
     status file and hand-off from the bash entry point.
   - Tests: SigV4 vectors, plus an integration test against MinIO as a CI
     service container. That test covers `412` handling, pagination and
     path-style.
3. **Settings:**
   - Router schema for the `TRANSPORT` and `S3_*` fields, the write-only
     secret, and `testConnection` for S3.
   - Transport switch in `ArchivePushSettingsForm` with provider presets
     (AWS, R2, B2, MinIO) that fill the endpoint format.
   - `src/demo/handlers/archivePush.ts`.
   - Router tests: the secret is never returned; the conf rejects CR/LF/NUL.
4. **Push window:**
   - `internet-control archive-egress open|close`, the service unit drop-in
     and the install block.
   - Script tests in the style of `scripts/tests/`.
5. **Docs:**
   - `PRIVACY.md` wording.
   - A Backup section in `DEPLOYMENT.md`.
   - Provider steps from the contract table.
   - `DEBUGGING.md` rows for the status file and egress chain.

## Open questions

- **curl on the pods.** Which curl ships on Pod 3/4/5 firmware, and does it
  have `--aws-sigv4` (7.75+)? If every generation does, a bash-only uploader is
  an option, but the Node plan doesn't depend on it.
- **`s3:if-none-match` in an identity policy.** AWS documents this condition
  key for bucket policies. The first real `terraform apply` must confirm that
  the pod policy's `DenyOverwrite` still lets a create-only PUT through and
  blocks a plain one. If it doesn't, move the statement into the bucket policy,
  conditioned on the pod principals.
- **Client-side encryption** (e.g. age to an owner-held key) before upload,
  now or later?
- **Reading the bucket back on a laptop.** Should `scripts/biometrics-archive`
  gain a `pull --from-s3` so training can read the bucket directly with the
  reader key?

## Refs

- [ADR 0018](0018-tmpfs-raw-frames.md): tmpfs RAW, cold archive and pruner
- `modules/archive-push/`, `src/server/routers/archivePush.ts` (sp-21): the ssh transport
- `scripts/biometrics-archive/README.md`: the laptop pull
- `deploy/aws-archive-bucket/README.md`
