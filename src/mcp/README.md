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

- **Intent-shaped, not endpoint-shaped.** 22 tools cover ~110 procedures. A tool is one thing a person would ask for.
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
| "How did I sleep?" / "Resting HR last night?" / "How much deep sleep?" | `get_sleep_summary` | `biometrics.getLatestSleep`, `getSleepRecords`, `getSleepStages`, `getVitalsSummary`, `getMovementSummary` |
| "Bedtime this week?" / "How many nights did I get up?" | `get_sleep_history` | `biometrics.getSleepRecords` |
| "Is my HRV trending down?" / "Was last night unusual?" | `get_vitals_trend` | `biometrics.getVitalsBaseline`, `getVitalsSummary` |

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
