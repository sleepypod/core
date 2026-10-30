# Morning journal and mode-only comfort

The authenticated web journal lives at `/sleep?view=journal` within Sleep. It keeps
the original Free Sleep check-in: wake date, physical side, restfulness (1–5),
temperature comfort, caffeine, alcohol, exercise and up to 500 characters of notes.
Both sides remain accessible regardless of current away mode or occupant names.
This is local storage and numerical analysis; no cloud model is called.

## Native and REST contract

`GET /api/v1/journal?side=left&date=2026-10-24&days=30`

- `date` defaults to today's calendar date in the Pod's saved time zone. It is
  the selected wake date **and** inclusive end of the analysis window.
- `days` is 1–90, default 30. Select an older date to access older history; the
  journal is not restricted to the most recent 90 days. Future and nonexistent
  local dates fail with 400. Date bounds begin at 1970-01-01.
- Response: `apiVersion:1`, `side`, `timeZone`, `deviceDate`, `from`, `through`,
  `selected`, `entries` (newest first), and `patterns`.
- Each selection has `side`, `date`, nullable UUID `revision`, and nullable
  `record`. A record contains `fields`, `side`, `date`, `timeZone`, `origin`
  (`free-sleep` or `sleepypod`), `createdAt`, `updatedAt`, `importedAt`.
  All non-null timestamps are epoch **milliseconds**.
- Imported creation/update timestamps are unknown (`null`), not migration time.
  Original record source and date zone survive edits. `updatedAt` records a new
  edit. Current names are not assigned retroactively to a historical side.

`POST /api/v1/journal` saves or removes one check-in:

```json
{
  "side": "left",
  "date": "2026-10-24",
  "expectedRevision": null,
  "fields": {
    "restfulness": 4,
    "comfort": "comfortable",
    "caffeine": false,
    "alcohol": false,
    "exercise": true,
    "notes": ""
  }
}
```

Use the exact revision from the selection, including a deletion's revision.
`expectedRevision:null` only matches a date never stored. `fields:null` removes
the current entry and its comfort feedback. A content-free tombstone prevents a
stale client from recreating deleted notes. Removal does not erase old backups,
the original migration archive, previous event summaries, or learning already
applied. Every successful mutation returns the new selection.

409 means another writer changed the selection. Retain the draft, refresh the
saved entry, and ask the owner which version to keep. After an uncertain network
result, read the selected entry before retrying; do not obtain a new revision and
blindly replay the edit. This endpoint uses optimistic concurrency, not durable
hardware command receipts. REST/tRPC reads and writes require owner authentication
and return private, no-store responses. Errors never include note contents.

tRPC names are `journal.get` and `journal.save`. Negotiate
`features.morningJournal` / `endpoints.journal`; the general legacy compatibility
prefix remains null. Demo reads/writes explain that a real Pod is required.

## Feedback and analysis

Journal and comfort-feedback writes commit in one database transaction, under
the shared per-side lock. Existing comfort-only clients change just the comfort
field of an existing full entry and rotate its revision. They cannot erase habits
or notes. Changes never rewind a consumed feedback cursor or reset manual pauses.

The latest seven check-ins in the chosen window supply average restfulness and
warm/cold counts. Habit associations require **five distinct matched wake dates
with and five without** a habit, independently in each source and date zone.
Their metric is the difference in average **bed-presence minutes**, not measured
sleep duration or a clinical outcome. The output reports matched and excluded
date counts. Sources are never pooled to satisfy the minimum.

Presence intervals are clipped to their recorded window and unioned across
overlapping records. A date with missing, malformed, oversized or unsupported
intervals is excluded instead of assigned zero or a partial duration. Future
wake timestamps are excluded even within the current calendar date. Different
time zones are excluded. Reads use at most 1,000 source records and 8 MiB of
interval JSON; larger ranges return `too_many_records` with no associations.
Imported history stays unqualified and cannot count as Preview evidence or
authorize automation. Notes are excluded from all numerical calculations.

The authenticated API returns the owner's notes for editing. No implementation
here sends notes or patterns to a model, MQTT, HomeKit, or an external service.
This does not establish encrypted-at-rest storage; access control and backups
remain the owner's responsibility.

## Migration and client state

Generated config migration `0041_morning_journal` adds `journal_entries`.
The offline importer restores all full journal fields and initializes revisions,
while retaining the byte-preserved source archive. Existing staged candidates
must be rebuilt from a fresh quiesced source before a controller switch.
Applying this schema alone does not import a preserved legacy JSON file.

The web editor keeps side/date drafts while the page stays open, preserves them
on errors, compares conflicting saved data, and requires explicit removal.
Drafts are not persisted in browser local storage. Refresh/closing the page
discards unsaved drafts; the UI states this. Native clients should use the same
revision contract and keep their own scoped drafts.

## Atomic comfort mode

`POST /api/v1/comfort/mode` accepts only `{ "side":"left", "mode":"preview" }`
(or `off`). `active` returns 412. No other configuration field is accepted.
The runtime reads current settings inside its write lock, replaces only mode,
recovers any pending manual pause, and preserves limits, sensor/bedtime options
and learning cursors. Response is the ordinary comfort status with
`features.modeOnly:true`. tRPC is `comfort.mode`. Use this operation for a
mode switch rather than GET followed by a full configuration replacement.

Active hardware adaptation remains locked. These changes do not qualify the
bed, import Apple Health, add model-generated coaching, or complete any Preview
night. Software and production-browser checks use synthetic isolated databases.
