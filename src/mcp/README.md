# Sleepypod MCP server

A curated [Model Context Protocol](https://modelcontextprotocol.io) surface over the tRPC API so LLM hosts
(Claude Desktop, Claude Code, Cursor, Home Assistant agents, ...) can read and control the pod without
per-client integration code.

It is **not** a second API. Every tool calls the same router procedures the web UI uses, in-process via
`appRouter.createCaller`, so validation, side locks, the pump-stall guard and mutation broadcasts all apply.

## Endpoint

| Transport | URL | Notes |
|-----------|-----|-------|
| Streamable HTTP, stateless, JSON responses | `http://<pod-ip>:3000/api/mcp` | Same trust model as the REST API: LAN only, no auth. Never port-forward. |

```bash
# Claude Code
claude mcp add --transport http sleepypod http://192.168.1.88:3000/api/mcp

# Claude Desktop / other hosts: add a remote MCP server with the same URL.
```

## Design rules

- **Intent-shaped, not endpoint-shaped.** 38 tools cover ~110 procedures. A tool is one thing a person would ask for.
- **CRUD collapses into an `action` enum** (`manage_schedule`, `manage_alarm`, `manage_automation`, `pod_maintenance`).
- **Temperatures accept the caller's unit** (`unit: "F" | "C"`, default = device setting) and are converted to the 55-110°F hardware setpoint in `units.ts`.
- **Errors come back as `isError` text** with the TRPC code, so the model can explain "pump stall guard tripped" instead of retrying blindly.
- **Annotations are honest.** Read tools set `readOnlyHint`; anything that deletes, restarts or re-energizes sets `destructiveHint` so hosts prompt for approval.
- **Big payloads are trimmed** (device status, sleep records). Everything else passes the router output through unchanged.
- **Tool output is untrusted model input.** Logs, sleep records and settings can contain text written by anything on the LAN or by firmware. The connected host reads it as data, not as instructions; the annotations above are hints to the host, not a security boundary.

## Intent catalogue

### Right now

| Intent (what a person says) | Tool | Procedures |
|---|---|---|
| "What's the bed set to?" / "Is my side on?" / "Is it priming?" | `get_pod_status` | `device.getStatus`, `settings.getAll` |
| "Who's in bed?" | `get_bed_occupancy` | `biometrics.getOccupancy` |
| "How warm is the room?" / "How bright was it overnight?" | `get_environment` | `environment.getLatestBedTemp`, `getLatestFreezerTemp`, `getLatestAmbientLight`, `getSummary`, `getAmbientLightSummary` |

### Sleep and health

| Intent | Tool | Procedures |
|---|---|---|
| "How did I sleep?" / "Resting HR last night?" / "How much deep sleep?" / "Did the pod agree with my watch?" | `get_sleep_summary` | `biometrics.getLatestSleep`, `getSleepRecords`, `getSleepStages`, `getVitalsSummary`, `getMovementSummary`, `getReferenceStages` |
| "Bedtime this week?" / "How many nights did I get up?" | `get_sleep_history` | `biometrics.getSleepRecords` |
| "Is my HRV trending down?" / "Was last night unusual?" | `get_vitals_trend` | `biometrics.getVitalsBaseline`, `getVitalsSummary` |
| "Import my Apple Watch data" | [`import_apple_watch_data`](#apple-watch-imports) | `biometrics.importReferenceVitals`, `biometrics.importReferenceStages` |
| "How are my stages classified?" / "Do I have enough watch data to tune?" | `get_sleep_stage_rules` | `sleepStages.getClassifier`, `biometrics.getReferenceStages`, `getSleepRecords` |
| "Would the movement-only preset match my watch better?" / "Try deep below 0.90" (dry run) | [`preview_sleep_stage_rules`](#sleep-stage-tuning) | `sleepStages.getClassifier`, `previewClassifier` |
| "Apply that ruleset" / "Go back to the default rules" | [`set_sleep_stage_rules`](#sleep-stage-tuning) | `sleepStages.getClassifier`, `setClassifier` |

### Control tonight

| Intent | Tool | Procedures |
|---|---|---|
| "Set my side to 68" / "Warm it up for an hour" | `set_temperature` | `device.setTemperature` |
| "Turn my side off" / "Turn the right side on" | `set_power` | `device.setPower` |
| "Go back to the schedule" | `resume_schedule` | `device.resumeTemperature` |
| "68 now, 72 at 3am, 78 at 6:30, wake at 7" (tonight only) | `run_once_curve` | `runOnce.start`, `getActive`, `cancel` |
| "Buzz my side" / "Stop the alarm" / "Snooze 10 min" | `manage_alarm` | `device.setAlarm`, `clearAlarm`, `snoozeAlarm` |
| "Prime the pod" / "Water level is low" | `prime_pod` | `device.startPriming` |

### Recurring schedules

| Intent | Tool | Procedures |
|---|---|---|
| "What's my schedule?" / "Why didn't it turn on?" / "Which curve runs Tuesday?" | `get_schedules` | `schedules.getAll`, `getNotes`, `settings.getAll`, `curveTemplates.list` |
| "Every weekday cool to 66 at 10pm" / "Wake me 7am with vibration" / "Delete Monday's alarm" | `manage_schedule` | `schedules.create/update/delete{Temperature,Power,Alarm}Schedule` |
| "Given my sleep data, build me a curve for weeknights" / "Put Late Warm on weekends" (preview, then apply) | [`apply_sleep_curve`](#sleep-curves) | `schedules.getAll`, `getNotes`, `settings.getAll`, `curveTemplates.list`, `put` |
| "What curves have I saved?" / "Which curves are on?" | `get_saved_curves` | `curveTemplates.list` |
| "Save that as Late Warm" / "Turn on Heatwave for weeknights" / "Pause Late Warm" / "Delete my Deep Cool curve" | [`manage_saved_curve`](#sleep-curves) | `curveTemplates.list`, `save`, `put`, `setActive`, `delete` |

### Settings

| Intent | Tool | Procedures |
|---|---|---|
| "What timezone / unit is it on?" | `get_settings` | `settings.getAll` |
| "I'm away until Friday" / "Keep it on all night" / "Turn off when I get up" / "Rename my side" | `set_side_settings` | `settings.updateSide` |
| "Switch to Celsius" / "Dim the LED at night" / "Prime daily at 2pm" / "Cap at 10 hours" | `set_device_settings` | `settings.updateDevice` |

### Automations (Autopilot)

| Intent | Tool | Procedures |
|---|---|---|
| "What rules are active?" / "What's controlling the bed tonight?" | `get_automations` | `automations.status`, `tonight`, `list` |
| "Pause all automations" / "Turn rule 3 live" / "Make a rule that cools when HR > 60" | `manage_automation` | `automations.setEnabled`, `setDryRun`, `setKillSwitch`, `create`, `update`, `delete` |

### Health and maintenance

| Intent | Tool | Procedures |
|---|---|---|
| "Something's wrong" / "Is the bed actually cooling?" / "Is everything OK?" | `diagnose_pod` | `health.system`, `hardware`, `thermal`, `waterLevel.getLatest`, `getAlerts`, `pumpAlerts.list`, `system.getDiskUsage`, `getVersion`, `internetStatus` |
| "Show me the logs" / "Why did the sleep detector crash?" | `get_logs` | `system.getLogs` |
| "Clear the pump alert" / "Restart the piezo service" / "Free up space" / "Update the software" | `pod_maintenance` | `pumpAlerts.acknowledgeAndRestore`, `waterLevel.dismissAlert`, `health.restartService`, `system.freeStorage`, `databases.checkIntegrity`, `system.triggerUpdate` |

### Resources and prompts

| Kind | Name | Purpose |
|---|---|---|
| resource | `sleepypod://status` | Same compact snapshot as `get_pod_status`, for hosts that attach resources as context. |
| resource | `sleepypod://settings` | Device and side settings. |
| prompt | `morning_report` | Summarize last night for both sides and flag anything degraded. |
| prompt | `bedtime` | Turn a plain-language request for one side into the right tool calls. |
| prompt | `design_sleep_curve` | Gather sleep history, vitals and room data, design a recurring curve with the curve-wizard guidance, preview it, apply on agreement. |

## Deliberately not exposed

Developer and installer surfaces stay REST-only: raw hardware opcodes (`device.execute`), raw sensor files,
database row browsing, sensor calibration triggers, MQTT/HomeKit/archive-push configuration, automation backtests,
cap-zone replays, and canonical vitals ingestion endpoints. They are either dangerous without context or useless to a
sleeper. Add a tool only when a person would say the sentence.

## Layout

```
src/mcp/
  server.ts        createSleepypodMcpServer(): registers tools, resources, prompts
  caller.ts        shared tRPC caller, jsonResult/textResult, runTool error mapping
  units.ts         unit resolution and °F setpoint conversion
  schemas.ts       described Zod fields reused across tools
  tools/*.ts       one file per intent group
  tests/           in-memory client tests with a mocked caller
app/api/mcp/route.ts   Next.js route handler (stateless Streamable HTTP)
```

## Adding a tool

1. Write the sentence a person would say. If an existing tool already answers it with one more argument, extend that tool.
2. Register it in the matching `tools/*.ts` with `title`, a description that says when to use it and when not to, and truthful `annotations`.
3. Call procedures through `getCaller()` inside `runTool`.
4. Add a case to `tests/server.test.ts` and a row to the catalogue above.

## Biometric calibration

| Tool | Shared procedures / purpose |
| --- | --- |
| `inspect_biometric_calibration` | Manifest, effective profile/runtime state, sessions/capabilities, reference/profile lists, stored-reading comparison, activation status/history, replay admission and paged raw-source metadata |
| `import_biometric_reference` | Preview and commit normalized references using the exact preview hash |
| `propose_biometric_profile` | Save an immutable agent-origin candidate; never activate |
| `manage_biometric_experiment` | Freeze datasets, inspect archive cursors, retain selected waveform sources, and create/list/read experiments with pinned protocols |
| `export_calibration_dataset` | Verify a frozen dataset and its retained archives; return the hashed bundle index and the LAN tar download path (no waveform bytes in the MCP response) |
| `backtest_biometrics` | Enqueue/status/list/cancel and compact report summaries |
| `apply_biometric_profile` | Explicitly authorized validated/manual activation, reset or rollback; validated activation pins evaluation/report identity, manual activation requires unvalidated acknowledgement |
| `release_biometric_artifacts` | Explicit reference deletion or dataset/report release; report release requires its content hash |

Tools use shared input contracts and call `biometricTuning` through `getCaller()`;
they do not implement a separate calibration or activation service. Mutation
tools use the underlying idempotency contracts. `inspect_biometric_calibration`
is read-only; activation, cancellation and cleanup tools carry destructive
hints. Hints guide hosts and are not authorization enforcement.

`backtest_biometrics` report responses identify that traces and per-night detail
were omitted and provide the local REST path for full results. Numerical
comparison provenance is limited to fifty entries with explicit total/truncation
metadata; scores still use all bounded source rows. Released reports remain
unavailable, rather than appearing successful with fabricated empty traces.

Resources `sleepypod://biometrics/algorithms` and
`sleepypod://biometrics/profiles/{left,right}` expose metric definitions and
actual profile/runtime state. Prompts `calibrate_biometrics`,
`explain_biometric_difference` and `develop_biometric_algorithm` provide versioned workflows. Prompts are host
workflow templates, not privileged instructions: bounded inputs, hash checks,
metric compatibility, concurrency and runtime receipts remain server concerns.
The calibration prompt treats import annotations as untrusted data, distinguishes
original readings from retrospective stages, and separates proposals from
explicitly authorized application without demanding repeat confirmations.

Only normalized reference ingestion and the scoped biometric replay workflow are
exposed. Arbitrary files, shell commands, executable algorithm uploads and
canonical-vitals writes remain excluded. Pod processing stays local, but an
external MCP host may send returned data to its model provider. These tools do
not authorize off-pod waveform transfer. Validated promotion requires matching
installed qualification policies and evidence; descriptive replay alone cannot
qualify a candidate.

The algorithm-development prompt guides an authorized host through the
[external experiment CLI](../../scripts/algorithm-experiments/README.md),
including inert proposals, isolated execution, prospective cohorts, attempt
accounting and retained evidence. It adds no execution or installation tool.
External qualification does not authorize installation: a normal reviewed
release and target-pod qualification are still required before shadow use.

### Replay detail and report resources

`backtest_biometrics` also supports `trace`, reusing the shared
`getBacktestTrace` request contract. Request the exact report hash, configuration,
optional cohort and cursor; at most 500 original trace intervals are returned.
Counts and cursors are explicit, with no downsampling or implicit reference
clock shift. Changed hashes and released reports surface the shared API errors.

The resource template `sleepypod://biometrics/reports/{id}` returns the same
verified, compact summary as the report action; UUIDs are validated and report
bodies remain untrusted data. Tool summaries provide this resource URI alongside
the local REST detail path. Resources never silently include the full traces or
per-night rows. The template is discoverable through `resources/templates/list`;
report IDs are discovered through the paginated backtest list.

Waveform workflows use `inspect_biometric_calibration` actions `replay_admission`
and `raw_sources`, and `manage_biometric_experiment` actions `inspect_raw_source`
and `create_waveform_dataset`. They forward the same API schemas and resource
checks. A deferred scan/publication is not evidence of retained data. Select
source IDs against the parent dataset hash; do not pass paths or raw bytes.

### Apple Watch imports

`import_apple_watch_data` imports extracted Watch heart-rate `samples` and/or sleep-stage
`segments` for an explicit `side`. Timestamps are Unix seconds; each array accepts up to
2,000 records. It uses the existing reference-vitals and reference-stages procedures,
so repeats skip duplicates and never overwrite pod measurements. Check `stageError`
for partial success before reporting completion.

For a full Apple Health export, use the upload API instead of passing a large archive
through model context. The Biometrics page exposes the same flow under **Upload Apple
Watch data**:

```sh
curl --fail-with-body -X POST \
  'http://POD:3000/api/biometrics/watch-upload?side=left&days=30' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @export.zip
```

The body is raw `export.zip` or `export.xml`, not multipart. `side` is required;
`days` defaults to 30 and accepts 1–90. Uploads are limited to 512 MiB and ZIP XML
members to 1 GiB uncompressed. Only Apple Watch heart rate and sleep stages in the
chosen period are imported. A ZIP must contain `apple_health_export/export.xml` or
`export.xml`; unrelated members are never extracted. Files are staged on persistent
storage and deleted on completion or failure. Only one upload/import runs at a time.

The response includes `vitals` and `stages` (new rows), `matchedVitals` and
`matchedStages` (eligible records), and `rejectedStageBatches` (conflicting stage
batches skipped while heart rate still imports). A disconnect or timeout can leave
some batches imported; retrying the same export is safe. Upload has a 30-minute
budget, followed by a separate 10-minute import budget. The browser allows 41
minutes for both phases and response cleanup. Like the existing API, this is LAN-only.

### Sleep stage tuning

`get_sleep_stage_rules` returns each side's saved classifier with indexed `rules[i].when[j]` and
`lowSignalRules[i].when[j]` conditions (nights whose piezo calibration quality is below
`lowSignalBelow` use the low-signal list), the preset ids, the last five change-log entries (each
with the classifier `before` it, for rollback), and reference coverage for the last 14 days
(`nights` with Apple Watch stages, `segments`, 5-minute `epochs`, `latestReferenceAt`, and
`truncated` when a query hit its row cap). `heartRateAgreement` compares the pod's heart-rate
estimate with the watch at matching times (Pearson correlation, mean absolute error); when it is
weak the HR-ratio rules classify noise and the `hint` points at the `hrvFirst` preset. A side with
`nights: 0` cannot be scored; import first.

`preview_sleep_stage_rules` is a dry run. Give exactly one of `presetId`, a full `ruleset`, or
`overrides` (`[{ list?, ruleIndex, conditionIndex, value }]` applied to the saved rules; `list`
defaults to `rules`) and up to 14 `nights`. It returns the resolved `candidateRuleset`, the saved
and candidate agreement with the reference (accuracy, Cohen's kappa, a
`confusion[reference][predicted]` epoch matrix and per-stage `recall`), mean stage minutes per
night, `kappaDelta` and the epochs of the latest night that change stage. Judge by kappa:
predicting one stage everywhere can score high accuracy with kappa near 0.

`set_sleep_stage_rules` takes the same arguments plus `reset: true` and saves through
`sleepStages.setClassifier`, so each change is logged with the ruleset before it and accuracy
before and after on the latest night (`accuracyBefore`/`accuracyAfter`; no-op saves are not
logged), and can be reverted by saving that previous ruleset again (`before: null`
means `reset: true`). Pass the preview's `candidateRuleset` as `ruleset` to save exactly what was
previewed; overrides are re-resolved against the rules saved at save time. A `CONFLICT` means
another save landed first: re-read with `get_sleep_stage_rules` and retry.

### Sleep curves

Every recurring curve lives in the schedule library (`curve_templates` table, `curveTemplates` router): a
named set point list in °F with a bedtime, wake, notes, `endAction`, its `days` per side and an `active` flag.
An active curve runs on its days; two active curves never share a side and day. Turning a curve on, or giving
it more days, moves shared days to it from the other active curves, and a curve left with no days turns off.
The temperature and power rows the scheduler reads are written from the library by
`src/server/scheduleLibrary.ts` through `planCurveSave` (`src/lib/sleepCurve/savePlan.ts`): each claimed day's
temperature and power rows are replaced, alarms are kept, flat-hold set points are dropped, and the power window
runs from the first to the last set point (`endAction: "maintain"` holds the last temperature). Editing a
temperature or power row one at a time (`manage_schedule`, `schedules.batchUpdate`) releases that day from its
curve, since the rows no longer match it; changing only `enabled` does not.

`apply_sleep_curve` runs a curve (2-48 `setPoints`) on `side` `left`, `right` or `both` for a list of `days`.
With `setPoints` it saves a new library curve (named by `name`, or after its days, e.g. "Weekdays curve") or
replaces the set points of the curve called `name`; with `curveName` it puts an existing curve on more days. The
curve turns on and keeps its other days. `mode: "preview"` writes nothing and returns the simplified curve,
`powerWindow`, the target `curve` (`name`, `isNew`, resulting `days`), the rows it `replaces` per side and day,
`movesDaysFrom` (days other curves give up), `alsoRewrites` (other days an active curve is rewritten on when its
set points change), `keptAlarms` and `warnings` (away mode, no on/off window); `mode: "apply"` with the same
arguments saves exactly that through `curveTemplates.put`. Optional `notes` (up to 1,000 characters) are stored on
the curve and written to each of its days (`schedule_notes`, shown on the curve's card and per day in
`get_schedules`); a library curve keeps its notes when omitted.

`get_saved_curves` lists the library with each curve's `active`, `days` and `endAction`. `manage_saved_curve`
`save`s set points under a name (replacing an existing curve's set points and keeping its days; a new curve is
saved off), `activate`s a curve on its saved days or, with `side` and `days`, on those days for that side,
`deactivate`s it (its days stop running; the curve and days are kept) or `delete`s it (its days stop running if it
was on). `get_schedules` reports per side the active `curves` and their days; a day no curve claims was written
one schedule at a time.

The Schedule screen shows the same library under "Curves", each with an on/off switch, and asks before moving days.
The AI curve wizard saves into it (off, no days), and curves older versions kept in browser localStorage move to
the pod on first load. On upgrade, migration `0028_schedule_library` adds every existing schedule to the library
once (matching days become one active curve, both sides when they match) without changing what the Pod does.
The `design_sleep_curve` prompt chains the data tools into a preview using `CURVE_DESIGN_GUIDANCE`, the
sleep-science text the copy/paste AI curve wizard also sends.
