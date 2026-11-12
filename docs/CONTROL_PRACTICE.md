# Practice the everyday controls

Approved improvement 18 brings three short lessons from the illustrated browser
guide into the app: request a temperature, review tomorrow's alarm, and
stop temperature and vibration independently. The existing illustrated guide
remains available for the longer introduction.

The owner web app opens the lessons from Settings → Connection. A personal
account opens them with Start practice. While practicing, the personal workspace's
ordinary controls are replaced by the lesson. Leaving returns focus to the same
entry button. Owner and personal entry points use the same React component and
local state machine; the personal bundle still has no owner client or hardware
modules.

## Example state

- Owner lessons request the example target immediately on a cooler/warmer tap,
  matching the owner bed controls. Personal web lessons keep a draft until
  Apply my target, matching that workspace. Reset preserves the relevant control
  behavior. Neither lesson pretends measured water instantly reaches the target.
- Tomorrow's example starts with a saved 07:00 wake. Review shows the warming
  lead, vibration time and unchanged regular week. Editing invalidates the earlier
  review. Saving requires the current time to match its review.
- Owner temperature stopping uses the power symbol and Turn off; personal web
  uses Stop temperature. Both match their real controls. Stop vibration is separate. Neither removes the next
  example alarm. The lesson requires trying both to mark it practiced.
- Lessons may be skipped or revisited. Skipping does not mark an action practiced.
  Restart resets every example. Leaving discards choices; there is no account,
  local-storage, analytics, cloud or controller request from a lesson.

The 65–90°F practice range and example times are illustrative. They are not saved
comfort limits, authorization for a command, or qualification evidence. Existing
routines continue independently of the practice interface.

## Joining separately

The existing browser invitation includes the controller origin and a single-use,
expiring invitation in its URL fragment. The join page clears the fragment and
uses the existing reviewed personal-account flow. The guide and practice explain
that a new sleeper uses this personal invitation, not the owner key. Joining does
not itself assign a side or activate a second sleeper.

Matching native lessons and a native invitation-link entry that avoids manually
typing an address remain part of improvement 18. Neither is claimed delivered by
this Core change. Actual two-device pairing and first-night acceptance are also
separate from simulator/browser checks.

## Original release validation

Fifteen model tests and two component tests pass. They exercise deliberate Apply,
bounded example choices, exact-time review, invalid times, midnight warming,
independent Stop, skip/reset behavior and exit. The component journey also
asserts that no fetch request or local-storage write occurs.

TypeScript, focused ESLint and the production build pass. Four production-browser
scenarios cover the complete journey, owner entry, phone dark/large text,
keyboard-only temperature application, lesson focus and return to the entry.
An earlier locator capture timed out waiting for element stability; the final
full-document captures and all four scenarios pass with unchanged test/action
timeouts. The once-run design detector reported no findings. The independent browser design review returned `ship` after opening all eleven
required captures. This verdict covers the browser extension only; native lessons,
native invitation entry and deployment remain outstanding. No live Pod, alarm, side assignment or household device changed.

## Control-fidelity correction

The follow-up checks each lesson against its actual owner/personal control, rather
than requiring the two different web controls to behave identically. Nineteen
focused model/component cases pass, including immediate owner requests, personal
review-before-Apply, reset behavior and independent power/vibration actions.
All four production-browser scenarios pass, covering both workspaces, separate
Stops, alarm review, reset and keyboard navigation. TypeScript, focused ESLint and
the production build pass. The first build used a Node 26 runtime incompatible
with the installed SQLite binary; the Node 24 build and browser execution pass.
The failed build log is retained rather than reported as product validation.

An independent targeted review returned `ship`: the corrected lesson matches
actual owner and personal controls, and all eleven full-page captures plus three
phone detail crops were inspected. CSS and live controls are unchanged. Native
lessons use immediate taps and Power off to match their own controls; their
validation and release remain separate from this browser result.
