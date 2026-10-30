# Offline Pod runtime staging

The working Free Sleep installation is retained. This path prepares a separate
Linux ARM64 application/runtime bundle on the development computer. It does not
run the upstream installer, purge Free Sleep, change global Node symlinks, edit
firewall/SSH configuration, start a controller or claim runtime rollback.

## Prepare

Use a clean committed checkout, Node 24.22.1 and pnpm 10.34.6. Build after the
commit so `.git-info` matches HEAD. Never reuse an old build with a new revision.

```sh
DATABASE_URL=:memory: BIOMETRICS_DATABASE_URL=:memory: pnpm build
python3 scripts/deployment/prepare_offline.py --output /absolute/new/private-directory
```

The output must not exist and must be outside the repository. The package has:

- `app/`: standalone Next server, static assets, migrations, pure biometric
  workers and a fresh locked production dependency install for Linux/ARM64/glibc.
- `runtime/`: the pinned Node Linux ARM64 distribution. No system binary changes.
- `source.tar.gz`, the AGPL license, a per-file/hash/symlink manifest and the
  compressed `sleepypod-runtime.tar.gz` with a SHA-256 sidecar.

Build tracing can include workstation databases. The packager excludes these,
`.env*`, keys, Python environments and workstation `node_modules`. It installs
production dependencies from the lockfile with lifecycle scripts disabled and
uses the reviewed better-sqlite3 prebuild for Node ABI 137. All native shared
objects must be Linux ARM64 ELF files. Escaping links, unsafe archive paths,
dirty sources, wrong build identity and demo builds are rejected. Existing
output is never overwritten. Failed preparation removes only its new directory.

Pinned runtime sources:

- [Node 24.22.1 security release](https://nodejs.org/en/blog/release/v24.22.1)
  and [official checksums](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt).
- [better-sqlite3 12.11.1 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1),
  Linux ARM64 Node 137 asset, digest pinned from its release metadata.
- [pnpm 10 supported architectures](https://pnpm.io/10.x/settings#supportedarchitectures).

These versions/digests live in `prepare_offline.py`; a dependency update must be
reviewed there instead of silently downloading a different native binary. The
normal installer also pins fresh Node installs to 24.22.1; its existing-major
version check is unchanged and does not upgrade every existing Node 24 install.

## Inert target probe

Transfer to a **new private staging directory**, verify the archive SHA-256 on
the Pod, inspect its manifest, then extract there. Never extract over `/` or the
working Free Sleep tree. From the extracted directory:

```sh
./runtime/node-v24.22.1-linux-arm64/bin/node ./app/scripts/deployment/probe_runtime.mjs
```

This checks Node/ABI/architecture, an in-memory SQLite query/integrity check and
one-pixel image encoding. It does not import the app, open hardware sockets,
start scheduled jobs, read health data or bind a service port. Its successful
result proves runtime dependency compatibility only.

## Separate cutover gates

### Sensor dependency probe

Prepare the Python modules in a separate staging tree using each committed
`uv.lock`: `uv sync --frozen --no-dev --no-install-project --no-build`. Keep the
environment, cache and interpreter outside the working Free Sleep installation.
Probe the selected interpreter's standard library before choosing system Python;
do not silently upgrade the numerical Python/dependency contract.

```sh
python3 scripts/deployment/probe_modules.py \
  --modules-root /absolute/staged/modules \
  --output /absolute/new-private-receipt.json
```

The probe imports real installed dependencies in isolated subprocesses and
checks a small NumPy/SciPy calculation. It never imports a daemon, connects to
NATS/DAC, starts a service or opens a database. It records package versions and
the exact project/lock hashes, continues across failing modules, and exits
nonzero if any environment fails. This is dependency compatibility evidence,
not evidence that a running sensor pipeline produces accurate vitals.

The initial Pod 4 probe found that HeartPy 1.2.7 imports `pkg_resources` without
declaring its provider. The piezo module now explicitly requires
`setuptools>=70,<82`, locked to 81.0.0. Numerical dependencies remain unchanged.
Setuptools removed that API in 82.0.0; remove this compatibility dependency when
HeartPy migrates to `importlib.resources`, after reviewing its numerical changes.
See [setuptools' removal notice](https://setuptools.pypa.io/en/stable/deprecated/pkg_resources.html).
CI runs the real dependency probe before adding test-only packages so mocks and
test tooling cannot conceal a missing production import.

### Controller switch

The [controlled handoff](CONTROLLER_HANDOFF.md) provides reviewed service
templates and a bounded trial that restores Free Sleep without changing the
boot default. Installing those units alone does not switch controllers.

Do not launch `app/server.js` against the working Pod casually: app startup owns
the DAC socket and can initialize hardware, scheduling and networking. Even
`CI=1` is not an authorization boundary for arbitrary API calls.

Before a controller switch, complete the quiesced data import, source/settings
review, required Python-module environments, service ownership/exclusion,
authenticated private origin and attended operational rollback. Retain original
service units, installation, Bluetooth state, stock configuration and dedicated
SSH. Only one controller owns the DAC socket and base connection. Qualification
and seven actual Preview nights remain separate from this packaging check.

## Tests

```sh
python3 -m unittest discover -s scripts/deployment -p 'test_*.py' -v
```

The suite checks archive traversal/link attacks, native architecture, secret/data
exclusion, corrupted cached artifacts and existing-directory preservation. It
runs in the Unit Tests CI job and the pre-push gate. Live staging receipts belong
in private local recovery records; no owner credentials belong in this document.
