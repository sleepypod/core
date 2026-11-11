# Controller identity for verified connection routes

The owner can eventually enroll a local address and a private HTTPS address for
the same controller. Matching the product string `sleepypod-core` is insufficient:
every controller has that name. This change supplies an authenticated logical
installation identifier for a client to compare after explicitly enrolling each
origin. It does not open a public gateway or select a connection automatically.

## Contract

`GET /api/v1/connection?challenge=<32-random-bytes-as-unpadded-base64url>` requires
an existing owner bearer or browser session. A challenge is exactly 43 base64url
characters. Missing, duplicate and extra parameters are rejected before accessing
identity storage. The response is private and must not be cached:

```json
{
  "schemaVersion": 1,
  "controller": "sleepypod-core",
  "installationId": "c5142bce-64cc-4f97-8df8-6a572155582e",
  "challenge": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
```

The values above are synthetic. A client must generate a new unpredictable
challenge for each probe, check its exact echo and recognized schema, and compare
the installation ID with its enrolled controller. The challenge detects stale
cached responses; it is **not** a new authentication mechanism or hardware
attestation. Authentication and TLS retain their usual responsibilities.

## Identity and storage

Migration 0060 adds one metadata table to the existing configuration database.
The first authorized probe initializes a random UUID under an immediate SQLite
transaction. Subsequent probes read the same row, including on a read-only copy.
Missing migrations, write failure during initialization, or corrupt existing
metadata return unavailable; corruption never silently generates a new ID.
No DAC, Bluetooth, sensor processing, schedule or automation is started by this API.

A database backup/restore preserves logical identity. A fresh database obtains a
new one. Restoring a copy onto different hardware also copies logical identity;
this API cannot identify the physical bed or distinguish cloned databases. Never
use it as proof of physical motion, occupancy, or sensor quality. Credentials and
an explicit user-selected origin remain required. No serial number, network
address, owner key, health record or account name is in the response.

The ordinary owner authentication and persistent personal privacy boundary apply.
A personal account cannot use this owner-only API. Future personal routing needs
its own account-scoped enrollment contract; do not reuse the household owner key.

## Native integration requirements

1. Verify a user-entered status endpoint before saving its address/key. An error,
   canceled form or changed account must leave the previous connection unchanged.
2. Enroll each alternate origin explicitly. Never send a saved key to discovery
   advertisements, redirects or a server-provided alternative address.
3. Require HTTPS for remote origins and reject credentials in URL components.
4. Match fresh installation responses before enabling automatic route choice.
   An older server without this API remains manually connectable; it must not be
   silently treated as a verified alternative.
5. Scope offline data to the enrolled installation/account and credential revision.
   Route switches must invalidate in-flight requests and must never replay controls.
6. Qualify actual local, remote, expired-access and work-VPN behavior before
   claiming that access works from anywhere.

## Validation record

Initial tests retained two expected-contract/fixture mistakes: the privacy boundary
returns 403, not 409; the native simulated decoder must wrap errors in the same
API error as the real transport. Neither changed a live installation.

Focused Core storage/authentication/capability checks cover 45 cases. Storage tests use
the generated migration and cover restart, separate installations, read-only access,
backup/restore and corrupt/missing storage. Route tests cover authorization, browser
origin, personal boundary, canceled request, query validation and private responses.
TypeScript, focused ESLint, generated-migration validation and the production Next.js build passed. Full pre-push and hosted gates, and native/live receipts, are recorded separately when completed.

The first full pre-push run passed 7,500 tests with 17 existing skips and failed two exhaustive schema assertions because the new table had not yet been added to their expected exports/snapshot. The reviewed update adds only `controller_connection_identity` and its three columns/unique constraint; no existing schema expectation was changed.
