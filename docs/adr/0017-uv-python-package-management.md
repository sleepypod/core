# ADR: Use uv for Python package management

## Context

Pod 3 (Python 3.9) and Pod 4 (Python 3.10) run Yocto-based Linux with an incomplete Python stdlib. Key missing modules:

- **`pyexpat`** — C extension for XML parsing, cannot be fixed by copying `.py` files
- **`plistlib`** — depends on `pyexpat`, also unfixable
- **`ensurepip`** — partially fixable via stdlib patching, but unreliable

This broke the entire Python venv+pip chain:
1. `python3 -m venv` fails (needs `ensurepip`)
2. `python3 -m venv --without-pip` + `get-pip.py` fails (`get-pip.py` needs `pyexpat` for XML parsing)
3. No pip → no package installation → biometrics modules can't be set up

We maintained two fragile scripts to work around this:
- `scripts/patch-python-stdlib` — downloads matching CPython source, copies missing `.py` files into system lib dir
- `scripts/setup-python-venv` — multi-fallback venv creation (normal → `--without-pip` + `get-pip.py`)

Both scripts failed on Pod 3 because the root cause (`pyexpat` being a missing C extension) is unfixable via `.py` patching. See [#380](https://github.com/sleepypod/core/issues/380).

## Decision

Replace `venv` + `pip` + `patch-python-stdlib` + `setup-python-venv` with [uv](https://docs.astral.sh/uv/).

uv is a Rust-based Python package manager from Astral. It creates virtualenvs and installs packages without using Python's stdlib — no `ensurepip`, `pyexpat`, or `pip` needed. It ships as a single static binary.

Each biometrics module gets a `pyproject.toml` (replacing `requirements.txt`) and a `uv.lock` for reproducible installs. The install script runs `uv sync` per module, which creates `.venv/` and installs locked dependencies.

### What changes

| Before | After |
|--------|-------|
| `scripts/patch-python-stdlib` | Deleted |
| `scripts/setup-python-venv` | Deleted |
| `requirements.txt` per module | `pyproject.toml` + `uv.lock` per module |
| `venv/` directory | `.venv/` directory (uv default) |
| `venv/bin/pip install -r requirements.txt` | `uv sync` |

### Why uv specifically

- **Bypasses broken stdlib entirely** — venv creation and package installation are implemented in Rust, not delegated to Python
- **Single static binary** — works on Yocto/musl without dependencies, installed via `curl | sh`
- **Lockfile support** — `uv.lock` provides reproducible builds with hashed dependencies
- **Fast** — 10-100x faster than pip for dependency resolution and installation
- **Widely adopted** — backed by Astral (creators of ruff), active maintenance

### Why not alternatives

- **pip + venv**: The approach we're replacing. Fundamentally broken on Yocto without `pyexpat`.
- **pipx**: Still delegates to pip/venv internally.
- **conda/mamba**: Heavy runtime, not suited for embedded deployment.
- **Poetry**: Uses pip under the hood for installation.

## Consequences

- uv (~30MB static binary) is downloaded during install — adds ~2s to install time
- `astral.sh` becomes an install-time dependency (alongside `github.com`, `nodejs.org`, `npmjs.org`)
- Existing installs with `venv/` directories will have orphaned dirs after update (harmless, can be cleaned manually)
- The biometrics modules' Python code is unchanged — only the packaging and environment setup changes
- Works identically on Pod 3, 4, and 5 — no pod-generation-specific branching needed
