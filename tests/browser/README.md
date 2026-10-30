# Calibration browser checks

Build the production application with hardware startup disabled, install the locked
Python runtime and Chromium, then run the isolated browser suite:

```sh
uv sync --locked --no-install-project --project modules/piezo-processor
CI=1 pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

The runner creates new configuration and biometrics databases in a private temporary
directory, applies both migration sets, and seeds normal device defaults plus a
synthetic ten-minute recorded session. It overrides caller database paths. Playwright
starts the standalone production server on loopback port 3218 with `CI=1`, which
disables hardware/service instrumentation. It refuses to reuse a server already
running on that port. Fixture databases are removed after the suite exits.
No request interception, demo transport, or mocked router is used.
Each run also creates a temporary owner token and a signed browser session;
the token is not printed or written to source. The routine workflow separately
checks anonymous rejection and authenticated REST requests.

Coverage:

- Import a separate synthetic Free Sleep archive, inspect original presence,
  paginate tied-timestamp vitals, switch sides and source-local date ranges,
  and retain byte-identical source/query databases. Reject anonymous REST/tRPC
  and stale snapshot IDs; verify private no-store headers and phone layouts.
  Imported history remains distinct from current metrics and Preview evidence.

- Publish a synthetic service alert into the real SQLite inbox, receive it in the
  foreground, mark it read, reload, and verify idempotence through REST. Reject
  anonymous REST/tRPC and cross-origin cookie mutations. Capture desktop and
  phone layouts without starting automation or hardware daemons.

- Keep power-only bedtime routines visible, move a complete overnight routine,
  reload its persisted state, reject an edit with a stale revision, preserve the
  unsaved browser draft, and check the 390-pixel layout. These use disabled
  synthetic routines and do not qualify physical Pod behavior.
- Review and save a numerical candidate through the UI and real tRPC API, assert the
  exact new SQLite revision, and reload to verify the persisted revision is displayed.
- Submit an out-of-range parameter, observe the server's validation error in the UI,
  and verify no revision was inserted. tRPC streaming batch errors use HTTP 200.
- Import a reference, save a candidate, freeze the recorded session with its reference,
  save a stage-replay protocol, queue and execute the real packaged worker, and view
  the report. Check that execution does not change stored vitals or active bindings.
  Explicitly request unvalidated manual application, verify pending delivery, run the
  shipped Python and stage consumers, verify acknowledgement, and roll back to the
  previous defaults. Verify acknowledgement again and preserve the other side.

`fixture.ts` supplies data and runs consumers normally hosted by background services.
Its replay admission is test-only and unmeasured; the Python runtime sees a single
synthetic empty-bed frame without a daemon, DAC transport, or hardware commands.
The report must say evidence is insufficient for validated improvement. This suite
checks the manual workflow, not waveform accuracy, qualified holdout promotion,
continuous live processing, or target-pod resource budgets.

CI runs these tests in the Browser Tests matrix entry. JUnit results, failure
screenshots, and successful report/rollback screenshots are written under
`test-results/browser` (ignored) and uploaded as CI artifacts.

- Save and remove a full morning journal entry through authenticated REST/tRPC,
  reject stale revisions (including deletion tombstones), preserve side-scoped
  drafts, explicitly resolve a concurrent edit and verify phone overflow. Notes
  and all check-ins are synthetic; no Pod, cloud model or automation is started.
