# Cover button remapping

Status: Proposed product and integration design, 2026-09-06.
Updated 2026-09-07 with the expanded observed gesture catalog.

## Recommendation

Add **Buttons** beside **Automations** in the existing Autopilot console.
Give it a dedicated, mobile-friendly remapping editor, and let conditional
bindings open in the WHEN / IF / THEN builder. Use one canonical binding
record in both views. Keep `/debug` focused on detection and execution
troubleshooting, with a link to edit the relevant binding.

Expose a direct localized route, `/{lang}/autopilot/buttons`, and a
**Cover buttons** link in Settings so users can find physical controls
without understanding Autopilot. The label in navigation should be Buttons;
use Remap as a task/action, rather than the name of a separate product.

This proposal follows inspection of the live `/en/debug` and
`/en/autopilot` pages on pod .88 and their current source. Debug contains
hardware/health/log panels; Autopilot already has Automations, Diagnostics,
and a sentence-based rule editor. No live settings were saved or changed.
Marketing images were mentioned but were not available in the conversation;
visual treatment of the cover itself remains to be matched to those assets.

## Primary experience

The Buttons page starts with the selected sleeper name, with Left/Right as
secondary labels. Match the application's existing side-name settings.
Show a simple vertical three-button cover illustration with top, middle,
and bottom hit targets. Do not assume the firmware side equals the viewer's
left when facing the bed; label the tested orientation explicitly and offer
**Identify my side** through live detection.

Beside the illustration, show assignments for the selected button:

| Gesture | Assigned action | Edit affordance |
|---|---|---|
| Single press | Plain-language description or No custom action | Change |
| Double press | Plain-language description or No custom action | Change |
| Triple press | Description where verified (currently left top) | Change |
| Hold | Availability and description when supported | Configure when supported |

Place observed four/five-click inputs under **More gestures** for the
verified button, rather than adding every count to the default view.

List **Button combinations** below individual buttons. Selecting a
combination highlights both buttons. The interface must not offer every
possible combination as verified simply because it can draw one.

Selecting Change opens a sheet on mobile and a panel/dialog on desktop:

1. **When:** side, button(s), and gesture, already filled from the selection.
2. **Do:** choose an action and its parameters.
3. Optional **Only when…** adds conditions using the automation editor.
4. Plain-language preview, then Save.

Illustrative preview, not an installed default:
“Double-press Jon's top button to make Jon's side 2°F warmer.”

Use concrete action labels such as Warmer, Cooler, Set temperature, Power
on/off, Snooze alarm, and Dismiss alarm as their implementations become
available. Do not expose an action merely because it appears in a design:
the current automation Action type implements only notify, temperature,
and power. Alarm actions require supported shared execution first.

Provide **Copy to other side** with a review of the destination assignments
and **Remove custom action** per binding. Avoid promising “Restore factory
behavior” or “Do nothing” until native firmware behavior can be controlled.
The capture showed firmware haptics and alarm handling that our observation
service does not disable.

## Detection and testing

Offer **Listen for a gesture** as a short, explicitly entered learning mode.
Highlight the detected button(s) and display the recognized gesture and side;
let the user confirm those fields. Capabilities should describe what the
connected cover has verified, rather than use a generic Pod-wide assumption.

A test mode shows “Detected → Matched binding → Would do …” and performs no
SleepyPod hardware action. Implement actual execution suppression before
calling a mode safe to test. Firmware haptics/native actions may still occur;
explain that limitation where the user starts the test. Exit learning/test
mode explicitly and automatically on timeout or disconnection.

Diagnostic details belong in an expandable technical view: raw record,
firmware timestamp, decoded edges, missing release, and rejected duplicates.
The ordinary flow needs only recognition, assigned action, and a clear reason
if a gesture cannot currently be assigned.

## Relationship to Automations

Add **Cover button** to WHEN. It selects side, button(s), and gesture with
the same controls as the Buttons editor. Conditions and actions reuse the
existing builder. Example: “When Jon double-presses top, if it is between
10pm and 7am, increase Jon's target temperature by 2°F.”

A simple remap is a button-triggered rule with no conditions. Editing it
from either page updates the same identity. Complex bindings remain visible
in Buttons as “Conditional · Edit rule”; never silently flatten their
conditions when opening the simple editor. List filters distinguish
Physical controls from Automatic policies.

Initially allow one enabled binding per side + gesture. Multiple actions
can belong to that binding. Conditional alternatives should be explicit
branches with deterministic first-match behavior, not hidden competing
rules. Introduce that richer branching only when both editor and executor
support it. Surface assignment conflicts before saving.

Button rules use live gesture testing and recent execution history. The
existing sensor-night backtest cannot replay physical presses until an
appropriate event history has been persisted; do not present sensor replay
as a valid button test.

## Execution contract

Share typed actions, conditions, hardware locks, validation, and audit
infrastructure with Autopilot. Introduce an immediate event entry point for
physical controls. Do not send presses through the current 60-second
`AutomationEngine` tick, sensor threshold detection, or numeric signal
window buffers. Preserve firmware click counts: `top:2` is one double-click,
not two single-click actions.

Physical buttons express manual intent. They should work when automatic
thermal policies are paused or the Autopilot policy switch is off, and a
temperature/power press should register the same manual-override behavior as
other manual controls. Use an explicit **Custom button actions** enable
setting. Keep the UI's policy pause distinct from a true all-actions stop.
All hardware safety interlocks still apply. Do not blindly reuse policy
cooldowns, the 12-actions/hour auto-disable rule, or run-once precedence for
manual presses; define and test those semantics as manual input behavior.

Conceptual trigger, to be added to the canonical validated rule model:

```ts
{ kind: 'coverButton', side: 'left', buttons: ['top'], gesture: 'doublePress' }
```

The incoming event additionally carries source identity, source epoch,
click count or edges, and firmware timing. Trigger matching consumes this
event immediately, then evaluates conditions against current state. Keep
input side and action target side explicit rather than relying on a nullable
rule side with ambiguous “both” semantics.

Use the normalized event identity to prevent file replay, reconnect, or
multiple consumers from firing the same action again. Serialize physical
commands through the existing per-side lock and hardware path. Audit a
single decision per event, including matched binding, action result, or
reason for skipping. Do not perform a hardware write from a React event
listener or depend on the browser remaining open.

## Capability boundaries from ADR 0024

[ADR 0024](../adr/0024-cover-button-signals.md) supplies the observed signal
contract and retained evidence:

- Left top/middle/bottom singles and top double/triple clicks are verified.
  Extra top bursts produced exact counts 4 and 5, corroborated by raw edges.
  Preserve the original structured `buttonEvent` count; five is an observed
  count, not a demonstrated maximum.
- Middle hold duration exists in low-level press/release counters; the
  structured event collapses it to an ordinary single click.
- September 7 captured all four edges for held-top/add-bottom/release-bottom/
  release-top. Other top+bottom trials lost a release. All-three onset is
  also captured, but bottom release is missing in that trial. A successful
  release sequence does not establish reliable release delivery generally.
- A mixed top+middle overlap followed by a second top click emits
  `middle:1,top:2` together. Multi-key counts alone do not identify a chord.
- GPI 105/127 during keypad recovery are not valid button assignments.
- Logs can arrive in batches, and RAW payloads can contain multiple CBOR
  items. Decode every item and use firmware counters for gesture timing.

Start with verified single/double/triple inputs for the applicable button;
make observed four/five-click inputs available under More gestures. Expose holds and combinations
only through an explicitly experimental capability path after the recognizer
handles missing edges, resets, timeouts, rearming, and suppression of the
firmware click generated by the same gesture. A partial or stale input must
not become a new command. Do not infer that all combinations or both sides
are validated from one successful overlap.

## Implementation order and acceptance

1. Normalize cover events on the server, preserve counts and identities,
   and expose live recognition plus persisted recent events. Test multi-item
   CBOR, replay, reconnect, malformed records, and keypad reset artifacts.
2. Add immediate button-trigger execution, canonical persisted bindings,
   and shared action/audit handling. Test single versus double dispatch,
   policy pause/manual override semantics, safety checks, and concurrency.
3. Build Buttons route, side selection, illustration, assignment editor,
   recognition/test mode, and Settings entry. Verify keyboard use, mobile
   layout, save errors, disconnected cover, and unsupported gestures.
4. Add Cover button to WHEN and round-trip simple/conditional bindings
   without losing conditions. Replace sensor backtest with gesture testing
   for this trigger type; show conflicting assignments before saving.
5. Validate experimental holds/combos against labeled physical trials and
   missing-edge fixtures before broadening the supported gesture catalog.

Delivering this design does not implement or deploy button bindings. The
next implementation should follow these dependency boundaries so the UI's
Save button always creates an executable, accurately represented binding.

## Source anchors

- `src/components/Autopilot/AutopilotConsole.tsx` — navigation and rule data.
- `src/components/Autopilot/RuleEditor.tsx`, `builderModel.ts` — builder.
- `src/automation/types.ts`, `engine.ts` — current trigger/action model and tick.
- `src/hardware/gestureActionHandler.ts` — existing manual gesture actions.
- `src/components/Settings/TapGestureConfig.tsx` — existing double/triple/quad
  tap configuration; keep those DAC tap gestures distinct from TTC buttons.
- `src/components/diagnostics/DiagnosticsConsole.tsx` — diagnostic surface.
