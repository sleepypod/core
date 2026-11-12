# Endel bedtime audio

Approved improvement 20 combines a reviewed native Shortcut handoff with a
browser setup guide. It is not yet qualified for unattended HomePod playback.

## Browser companion

`/guide/bedtime-audio.html` is available from owner Home and the personal
workspace. Four steps explain Endel setup, separate Start/Pause Shortcuts,
review in the native app, and the distinction between requested settings,
Shortcut completion and a listening observation. The original requested volume
is 35 percent; timer and destination support must be checked in the installed
actions. A saved Sleepypod setting does not edit a Shortcut.

The guide is static and works without JavaScript. Its optional step navigation
and result examples use ephemeral page state. They do not send API requests,
retain account information, play audio or operate the Pod. The fixed
`sleepypod-bedtime://open` link only opens the native review. Manual Endel Pause
instructions remain available on every step.

## Native handoff and shared quiet

The native app retains a device-only, per-account setup and one-use handoff
record. It reads fresh shared quiet state before explicit Start, then opens the
reviewed saved Shortcut. A returned callback is not a physical speaker reading.
The user separately records whether sound was heard or stopped. Unknown results
are never automatically replayed. Pause requires confirmation that this is still
the audio session the person started.

Core PR 137 adds the authenticated owner shared-quiet read, with a 15-second
freshness bound and no actuator path. Personal reads retain their authenticated
session boundary. Missing or expired quiet data withholds native Start; these
launch checks do not claim to interrupt audio automatically when quiet begins
after playback has already started.

```mermaid
flowchart LR
    Guide[Browser setup guide] --> Review[Native reviewed setup]
    Review --> Quiet[Fresh shared quiet]
    Quiet --> Shortcut[Explicit saved Shortcut]
    Shortcut --> Return[Shortcut reported result]
    Return --> Observation[Separate listening observation]
```

## Research and evidence

Checked November 12, 2026:

- [Endel Siri setup](https://endel.zendesk.com/hc/en-us/articles/360021256179-You-want-to-launch-Endel-on-your-iPhone-with-Siri-Shortcuts)
  documents adding its mode actions to Siri Shortcuts.
- [Endel's user guide](https://endel.zendesk.com/hc/en-us/articles/360015068699-User-Guide)
  documents AirPlay, Pause and timers. It does not prove that the installed
  Shortcut exposes every timer or routing parameter.
- Production build and targeted lint pass. Six isolated production-browser
  scenarios cover all steps, phone dark mode with enlarged text, tablet keyboard
  navigation, no-JavaScript reading, owner/personal entries, no command requests
  and actual light/dark text contrast. All eight measured color pairs exceed
  4.5:1. Detector cross-theme warnings are retained with computed-style evidence.
- Ten final screenshots are recorded in
  `.impeccable/review/bedtime-audio-guide-reviewed/capture-inventory.json`.
  Independent review found one no-JavaScript example mismatch. The interactive
  example now stays hidden until its listener is installed; the reviewer scored
  that fix resolved after all viewports and the fallback were recaptured.

The native implementation separately passes 1,720 application/framework tests
(nine existing skips) and eight UI scenarios per iPhone/iPad simulator. Its
independent reviewer scored four presentation/recovery corrections resolved.
That evidence does not establish installed Shortcut, speaker or timer behavior.

## Remaining delivery

Merge and distribute the native and browser changes, then configure and test the
actual Start/Pause actions, mode, route, 35-percent volume, duration, calls,
partner quiet and failure recovery. If an action cannot configure the timer or
destination, keep the tap-to-finish step explicit. Locked-phone and unattended
operation need their own tests. No new audio, alarm, household arrangement or
Pod routine was activated during this source implementation.
