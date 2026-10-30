# Personal browser workspace

`/household/index.html` combines private account preparation with capability-gated
personal bed controls and a complete weekly routine editor. It is separate from
the owner application; it never mounts owner providers or sensor streams. None
of the household runtime flags is enabled by building or merging this client.

## The everyday flow

1. Join with your own invitation, save your personal connection key privately,
   and connect your account. Joining alone does not assign a side.
2. When personal controls are enabled, review your permitted zones. Solo mode
   shows both zones separately; different reported targets say **Mixed targets**.
   Assigned mode exposes only your own zone. Measured water temperature, reported
   controller target and last requested target have distinct labels.
3. Choose a new target and hold duration, then Apply. One POST is made. An
   acknowledgment is not a physical observation. Live values disappear when
   stale; normal controls require fresh, non-priming, water-OK observations.
4. Stop temperature and Stop vibration are explicit actions with fresh authority
   checks. They remain available after an unknown ordinary outcome if recovery
   storage and the current personal scope are available. Stop preempts ordinary
   changes or routine publications still waiting in this workspace before POST.
   Already-sent requests cannot be recalled; their outcomes require recovery and
   physical review. Stop does not erase future saved routines.
5. Prepare your weekly draft. Every phase, end action, custom snooze second,
   wake window, vibration setting and note survives editing. Fahrenheit inputs
   preserve the Pod's whole-degree settings; live readings honor the display unit.
6. To start from the operating week, explicitly load it into the editor. It is
   never automatically replaced with a new account's default draft. Save privately,
   compare all seven nights, review removals, and acknowledge both replacement and
   possible current-target effects before publishing. The receipt separates a
   saved week from confirmed scheduler registration.

## Browser recovery and privacy

The HttpOnly personal session stays outside the module. The transport permits
only specific methods on same-origin personal endpoints, refuses redirects,
limits response bytes, and pins the expected sleeper header. Current session,
assignment and configuration are rechecked before each write.

Before a POST, an IndexedDB transaction reserves an account-bound recovery
reference across tabs. It contains the Pod/household/account/sleeper IDs, request
ID, expiry, operation kind and a canonical receipt fingerprint. It contains no
credential, routine body, temperature setting or receipt body. Unlike native
Keychain storage, ordinary browser storage is not a secret vault: these identifiers
and fingerprints are local metadata and clearing site data removes them.

Only the current person's references are displayed. Sign-out, revoked sessions,
account changes and page departure clear the in-memory view and abort reads.
References survive so that reconnecting the same person can GET their own result,
including after an assignment change. There is no replay on reload or reconnect.
A 403/409 after publication may follow a successful commit; uncertainty is retained.
Capacity is bounded and unresolved entries are not silently evicted. An expired
unknown entry can be removed only through an explicit personal-review action; that
never turns an unknown outcome into success or failure.

## Build and verification

`pnpm build:personal-workspace` bundles `src/household/web/entry.tsx` into the ignored
`public/household/personal-runtime.js`. Both `prebuild` and `predev` run it. After
editing this isolated entry during development, run the command again. The build
rejects hardware, database, streaming, HomeKit and owner server modules; the pure
Zod validation schema is the only server-directory exception.

Unit tests exercise expiry, authorization changes, late responses, persistence
failure, Stop ordering and exact receipt/whole-week validation. Browser scenarios
exercise real IndexedDB, reload recovery, whole-week review, phone layout and
large text using intercepted personal API responses. They do **not** prove live
hardware behavior. The separate household browser scenario exercises actual
SQLite/HTTP account isolation and deliberately disabled command/publication APIs.

Live deployment, reviewed two-person activation, privacy for history/Health and
physical zone/alarm qualification remain separate release gates. This client does
not enable them or change the current Pod.
