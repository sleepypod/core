# Read-only Homebridge cache publisher

`scripts/bedroom/homebridge-cache.mjs` runs on the Homebridge Windows host. Every
15 seconds it reads the already-enabled local HAP accessory cache, then forwards
only selected readings over an encrypted SSH connection to the Pod. A successful
cache query is **not** a new hardware measurement. All reports use `cached` and
are excluded from room-derived Autopilot, even if a source is selected for control.

The Pod receiver is `cache_ingest.py`, installed root-owned outside the writable
app data. Its configuration contains the owner environment path and an explicit
source-ID allowlist. The owner key stays on the Pod. The publishing key permits
only the forced receiver command; it cannot read sleep data, change configuration
or issue thermal, vibration or base commands. Responses contain counts only.
The receiver rejects caller-supplied commands, stale envelopes, duplicate fields,
unknown sources, nonfinite values and payloads over 32 KiB.

Provisioning must use a pinned Pod SSH host key and a private Windows directory.
`Install-HomebridgeCache.ps1` accepts immutable source revisions and a publisher
SHA-256. It requires exactly one H5106, H712C and H7161 on the inspected bridge;
ambiguous devices stop setup. It preserves Homebridge configuration and pairings.
The SYSTEM task starts at boot, retries failures, and uses no owner credentials.

If installation stopped after key generation but before writing configuration,
use `-ResumeIncomplete` with the same pinned publisher and host parameters. It
requires exactly the four expected setup/key files, rejects links or unknown
files and any existing scheduled task, verifies the publisher checksum, and
derives the public key to confirm the pair before continuing. Both key files are
preserved byte-for-byte. An installation that progressed further must be
inspected rather than overwritten. The Windows CI test covers this interrupted
state, mismatched keys, unexpected files and refusal to replace a complete task.

Authorize the generated public key only after inspecting the mapping. The
`authorized_keys` entry must contain `restrict`, an exact `from` host restriction,
and a `command` invoking Python with `-I`, the reviewed receiver and its private
configuration. Preserve all existing administration keys. Validate sshd's config
before testing; no SSH service restart is needed to add an authorized key.

Receiver configuration (local/private; example paths and source IDs):

```json
{
  "environment": "/persistent/sleepypod-unified/controller.env",
  "sourceIds": ["govee-h5106-temperature", "govee-h5106-humidity"]
}
```

Configure the matching bedroom sources through the authenticated versioned API.
Keep `useForControl: false`. Air quality category zero means unknown; it is
reported unavailable, never translated to a particulate concentration. Numeric
zero temperature is retained as cached evidence, not silently repaired.

Acceptance requires checking a publication, observing unavailable/stale state
when the publisher stops, verifying reconnection, and confirming rejected shell
and actuator attempts with the restricted key. Cached readings do not qualify
sensor freshness or demonstrate physical appliance operation. HomePod temperature
and humidity need a separate supported Apple Home export; Apple TV discovery
alone does not provide those measurements.

```sh
python3 -m unittest discover -s scripts/bedroom -p 'test_*.py'
node --test scripts/bedroom/homebridge-cache.test.mjs
```
