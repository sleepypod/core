# Test coverage audit — 2026-09-06

Audited `dev` at `2e13b79` in an isolated worktree, using Node 24.16.0,
pnpm 10.34.5, and Python 3.10.19. This is a unit-test audit; passing results do
not establish real-Pod, browser-layout, or end-to-end correctness.

## Measurement findings

- The original Vitest run passed **3,780 tests in 158 files**, with one existing
  skipped test. It reported **98.21% statements / 94.71% branches / 98.75% lines**.
- That report omitted 113 unimported TypeScript files under `src/` (including
  type-only files) and included some test helpers. It did not measure the whole
  application. The new explicit include covers `src/`, `app/`, instrumentation,
  and the proxy; test files, helpers, and declarations are excluded.
- With the added tests and corrected denominator, coverage is **64.44%
  statements / 53.09% branches / 65.49% lines**. The lower aggregate reflects
  newly visible untested code; it is not a test-coverage regression. There is
  deliberately no arbitrary global threshold imposed on the existing backlog.
- Python CI previously counted test modules and measured only statements. The
  shared `.coveragerc` excludes test code and enables branches for all six CI
  module jobs. The prototype in piezo-processor remains visible in the report.

## Tests added

**48 TypeScript cases** across four suites, preserving all pre-existing tests:

| Area | Behavioral checks | Final lines / branches |
| --- | --- | --- |
| Automation biometrics reader | Real SQLite ordering and side filters; null vs zero; Fahrenheit conversion; partial zones; exact 5m/15m/30s freshness boundaries; cap scalar/matrix/reference handling; partial and total DB failure | 100% / 100% |
| Temperature dial | F/C keyboard steps in hardware units; 55–110°F clamps; pointer preview, deduplication, release/cancel, arc gap, scaled viewport; off-state inactivity; accessible values | 100% / 96.05% |
| Power button | Selected/linked side commands; neutral power-on setpoint; power-off payload; optimistic timeout and server acknowledgement; pending state; partial linked failure recovery | 100% / 91.66% |
| Diagnostic charts | Actual data sorting without mutation; downsampling keeps latest sample; missing values and precision; finite thermal domains and axis/tooltip formatting | 100% / 100% each |

The reader previously had only 10.2% line / 0% branch coverage. The dial and
power button were absent from the report. Both chart suites previously had
71.42% line coverage, and their rendering tests did not assert data ordering.
Remaining dial branches are defensive null fallbacks behind non-null props and
the mounted SVG ref; the power button's remaining branch is the handler guard
behind the disabled pending button. No private handlers are exposed to force
these branches.

**120 Python cases** across three new suites:

- RAW parser: all supported integer and byte-length widths; every truncated
  prefix; empty markers; exact cursor position between consecutive records;
  real-file payload sizes crossing 4 KiB buffers; malformed framing and 1 MB
  payload guard. `common/cbor_raw.py` reaches **100% lines and branches**.
  The private import explicitly avoids another suite's `sys.modules` stub.
- Calibration triggers: temporary-file invisibility, non-destructive reads,
  oldest-file consumption, invalid JSON/non-object removal, same-millisecond
  write uniqueness and FIFO across counter 9→10, and failed-rename isolation
  using real temporary files.
- Calibration algorithms: minimum usable samples; final quiet-window selection;
  6/8-channel capSense2 and optional reference channels; standard-deviation
  floors; signed piezo lists/bytes/bytearrays and trailing bytes; minimum and
  signal-scaled thresholds; inclusive HR/HRV/BR bounds; dynamic-bound flags;
  missing vitals; calibration-age decay and signal-to-noise scoring. These
  assert the existing algorithm contract, not clinical validity.

`common/calibration.py` improves from **19% to 80% combined statement/branch
coverage**. Its remaining areas include persistence, temperature calibration,
legacy presence helpers, and exceptional filesystem paths.

## Remaining coverage inventory

This audit prioritizes untested control commands, sensor framing, calibration,
and live automation inputs. It does not claim every coverage gap is closed.
Many UI components have tested hooks/utilities but no component-level behavior
tests. Reported coverage now makes that distinction explicit.

| TypeScript area | Lines | Branches |
| --- | ---: | ---: |
| `app` | 91/182 (50.00%) | 56/106 (52.83%) |
| `instrumentation.ts` | 148/168 (88.10%) | 57/86 (66.28%) |
| `proxy.ts` | 0/19 (0.00%) | 0/9 (0.00%) |
| `src/automation` | 610/614 (99.35%) | 561/572 (98.08%) |
| `src/components` | 422/4573 (9.23%) | 418/4919 (8.50%) |
| `src/db` | 197/197 (100.00%) | 59/67 (88.06%) |
| `src/hardware` | 1616/1618 (99.88%) | 1000/1039 (96.25%) |
| `src/homekit` | 539/539 (100.00%) | 224/236 (94.92%) |
| `src/hooks` | 723/727 (99.45%) | 478/497 (96.18%) |
| `src/lib` | 537/537 (100.00%) | 389/398 (97.74%) |
| `src/locales` | 0/0 (100.00%) | 0/0 (100.00%) |
| `src/modules` | 0/0 (100.00%) | 0/0 (100.00%) |
| `src/providers` | 35/101 (34.65%) | 4/38 (10.53%) |
| `src/scheduler` | 620/620 (100.00%) | 233/239 (97.49%) |
| `src/server` | 1671/1673 (99.88%) | 1182/1212 (97.52%) |
| `src/services` | 152/155 (98.06%) | 79/85 (92.94%) |
| `src/streaming` | 984/987 (99.70%) | 732/771 (94.94%) |
| `src/ui` | 0/37 (0.00%) | 0/37 (0.00%) |
| `src/utils` | 12/12 (100.00%) | 6/6 (100.00%) |

Highest-priority follow-ups are schedule/automation editors (mutation payloads,
validation and failure recovery), device settings (save/revert and side scope),
and VitalsPanel/PiezoWaveform (stream lifecycle and cleanup). Large uncovered
presentation surfaces also include DiagnosticsConsole, VitalsChart,
DualSideChart and SleepStagesCard. Hardware paths already have high statement
coverage, but NATS lifecycle/probe branches and startup instrumentation still
need targeted failure-path work.

| Python CI scope | Passing tests | Statements | Branches |
| --- | ---: | ---: | ---: |
| `common` | 194 | 700/888 | 242/308 |
| `cover-buttons` | 11 | 43/71 | 15/22 |
| `environment-monitor` | 21 | 71/131 | 15/42 |
| `calibrator` | 12 | 63/185 | 24/74 |
| `piezo-processor` | 84 | 442/909 | 142/322 |
| `sleep-detector` | 31 | 268/475 | 70/162 |

Python follow-ups: common calibration persistence/temperature correction;
calibrator orchestration; sleep-detector run-loop transitions; environment
writer lifecycle; NATS reconnect/shutdown and RAW rotation. The piezo-processor
scope includes the untested `prototype_v2.py`; its production `main.py` has
76% combined statement/branch coverage. Unit stubs do not establish runtime
compatibility with Pod-specific services.

## Validation and reproduction

- Full Vitest run: **3,828 passed, one existing skipped, 162 files passed**.
- Full six-job Python matrix: **353 passed** under Python 3.10.
- TypeScript typecheck and ESLint on all added TS/TSX tests passed.
- CodeRabbit follow-up: the strengthened FIFO assertions failed against the
  original lexical queue ordering. Queue reads and deletion now share numeric
  timestamp/PID/counter ordering, preserving existing unpadded filenames.
  This is the only production runtime change in the audit PR.

```sh
pnpm install --frozen-lockfile
pnpm test run --coverage --maxWorkers=4
pnpm tsc
pnpm exec eslint src/automation/tests/biometricsSignalReader.test.ts \
  src/components/TemperatureDial/tests/TemperatureDial.test.tsx \
  src/components/PowerButton/tests/PowerButton.test.tsx \
  src/components/diagnostics/tests/trendChartData.test.tsx

# In modules/ (Python 3.10 with pytest, pytest-cov and cbor2):
python -m pytest common --cov=common --cov-config=.coveragerc --cov-report=term-missing
# In each module directory, with its test/runtime dependencies installed:
python -m pytest . --cov=. --cov-config=../.coveragerc --cov-report=term-missing
```

The new Vitest `coverage/coverage-summary.json` and the existing lcov output
provide machine-readable results; Python CI continues uploading coverage XML
and JUnit for each module independently.
