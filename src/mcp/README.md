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

- **Intent-shaped, not endpoint-shaped.** 29 tools cover ~110 procedures. A tool is one thing a person would ask for.
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
| "What's my schedule?" / "Why didn't it turn on?" | `get_schedules` | `schedules.getAll`, `settings.getAll` |
| "Every weekday cool to 66 at 10pm" / "Wake me 7am with vibration" / "Delete Monday's alarm" | `manage_schedule` | `schedules.create/update/delete{Temperature,Power,Alarm}Schedule` |
| "Given my sleep data, build me a curve for weeknights" / "Put Late Warm on weekends" (preview, then apply) | [`apply_sleep_curve`](#sleep-curves) | `schedules.getAll`, `settings.getAll`, `schedules.batchUpdate`, `curveTemplates.list` |
| "What curves have I saved?" | `get_saved_curves` | `curveTemplates.list` |
| "Save that as Late Warm" / "Delete my Deep Cool curve" | [`manage_saved_curve`](#sleep-curves) | `curveTemplates.list`, `save`, `delete` |

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
database row browsing, calibration triggers, MQTT/HomeKit/archive-push configuration, backtests and
cap-zone replays, and vitals ingestion endpoints. They are either dangerous without context or useless to a
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

`apply_sleep_curve` saves a whole curve (2-48 `setPoints`) for `side` `left`, `right` or `both` on a list of
`days`, through `planCurveSave` in `src/lib/sleepCurve/savePlan.ts`, the same planner the Schedule screen's
curve editor uses. Each target day's temperature and power rows are replaced in one `schedules.batchUpdate`
transaction; alarms are kept. Flat-hold set points are dropped, and the power window runs from the first to
the last set point (`endAction: "maintain"` holds the last temperature). `mode: "preview"` writes nothing and
returns the simplified curve, `powerWindow`, the rows it `replaces` per side and day, `keptAlarms` and
`warnings` (away mode, no on/off window); `mode: "apply"` with the same arguments saves exactly that.
Instead of `setPoints` it accepts `curveName`, a saved curve. Optional `notes` (up to 1,000 characters) are
written to every target day (`schedule_notes` table, `schedules.getNotes` / `batchUpdate.notes`) and shown on
the curve's card; they replace the days' previous notes, default to the saved curve's notes with `curveName`,
and appear per day in `get_schedules` and in the preview's `replaces`.

Saved curves (`curve_templates` table, `curveTemplates` router) are named set point lists in °F with a
bedtime, wake and notes, not tied to a side or day. `manage_saved_curve` saves (replacing a curve of the
same name) or deletes one; `get_saved_curves` lists them. The Schedule screen lists them under "Saved curves"
(opening one starts a new curve with its set points and notes), the AI curve wizard saves into the same table,
and curves older versions kept in browser localStorage move to the pod on first load.
The `design_sleep_curve` prompt chains the data tools into a preview using `CURVE_DESIGN_GUIDANCE`, the
sleep-science text the copy/paste AI curve wizard also sends.
