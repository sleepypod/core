# Platform product review: 24 improvements

Reviewed 10–11 November 2026. This refines the existing 24-item approved plan;
it does not activate hardware, change schedules, or restart a request for approval.
The [implementation ledger](PLATFORM_IMPROVEMENTS_2026-11.md) remains authoritative
for delivery and acceptance. “In source” does not mean installed on Luca's Pod or
distributed to his iPhone.

## What was inspected

- The legacy Free Sleep repository, the current Core worktree at `565c030`, and
  the native connection/release work through `37558ad`. The native changes are
  ahead of the distributed app and still require integration/release checks.
- Tonight, connection enrollment, encrypted offline reading, personal-report
  rendering, Watch recording guidance, comfort limits, target-response research,
  journal context, wake plans, household boundaries and their acceptance records.
- Phone/tablet simulator captures and the web journal-discovery captures. These
  establish rendered software behavior, not physical sleep outcomes.
- Official Eight Sleep product, support and App Store descriptions; Sleepme,
  Oura, WHOOP and Sleep Number documentation; Apple alarm/audio capabilities.
  Competitor product claims are descriptions, not independent validation.

## Competitive lessons

| Product | Useful benchmark | Implication for our platform |
| --- | --- | --- |
| Eight Sleep | Automatic temperature, daytime context, sleep reports, thermal/vibration waking and two profiles | Present one understandable nightly plan, with context and reasons for adjustments. Do not assume new-Pod hardware or proprietary model performance applies to Pod 4. |
| Sleepme | Schedule-linked automation, early/late bedtime behavior and a recent-activity log | Explain schedule precedence and manual overrides clearly; an automated action should be attributable and reversible. |
| Oura | Habit discoveries, longitudinal trends and conversational interpretation | Connect a short daily brief to evidence, adequate coverage and optional follow-up questions. |
| WHOOP | Sleep planning, journal context and calibration milestones | Make the next useful action obvious while data accumulates; do not hide everything behind a technical model screen. |
| Sleep Number | Programs tied to each sleeper's login and night-specific manual overrides | Separate identity, physical side, recurring preferences and a one-night exception. |

Sources: [Eight Sleep Autopilot](https://www.eightsleep.com/autopilot/),
[official iOS listing](https://apps.apple.com/us/app/eight-sleep/id1086913845),
[Sleepme Hiber-AI](https://help.sleep.me/hiber-ai/what-is-hiber-ai-and-its-features),
[Sleepme activity log](https://help.sleep.me/frequently-asked-questions-app/how-to-view-and-what-is-recent-activity),
[Oura Discovery Hub](https://support.ouraring.com/hc/en-us/articles/30697762898323-Discovery-Hub),
[Oura Advisor](https://support.ouraring.com/hc/en-us/articles/39512345699219-Oura-Advisor),
[WHOOP calibration](https://support.whoop.com/s/article/Calibration-Timeline),
[WHOOP Journal](https://support.whoop.com/s/article/WHOOP-Journal-Overview?language=en_US),
[Sleep Number SmartTemp](https://support.sleepnumber.com/hc/en-us/articles/115000114414-Using-SmartTemp-Programs).

## Recommendations

Priority 1 means remove current friction or protect a night's operation. Priority 2
means make the product more useful and personal. Priority 3 means qualified
expansion after the earlier foundations work. The order is about value and
dependencies, not a promise that every preceding item must finish before work on
the next begins.

1. **Automatic home and away access — priority 1.** Pair two explicit addresses
   once and prove they identify the same authenticated installation. Keep a
   healthy route, select an available verified alternative after network failure,
   and distinguish rejected access from an unreachable controller. The remote
   route should coexist with work VPN requirements. Connection verification is
   now implemented; automatic lifecycle integration and an actual HTTPS gateway
   remain. Success means real home/cellular/work-network checks without manual
   address or VPN switching.

2. **A useful app during outages — priority 1.** Extend the encrypted owner
   library into a complete per-person offline experience: recent nights, reports
   and the last confirmed wake plan remain readable with individual timestamps.
   A transport change must preserve the same person's data. Controls remain
   unavailable when their result cannot be confirmed. Owner caching exists;
   personal-account coverage and route continuity still need completion.

3. **One calm Tonight screen — priority 1.** Complete the web/native overview
   around current side, temperature, next wake and actual Autopilot mode. In the
   morning, prioritize the latest night. Existing Tonight source is a foundation;
   refine the hierarchy around a half-awake person's task, with diagnostics and
   lengthy evidence explanations expandable. Success is completing temperature,
   Stop and next-wake tasks without hunting through settings.

4. **An unmistakable overnight comfort limit — priority 1.** Make the allowed
   overnight band and wake exception visible together: for example, a narrow
   reviewed band around 70°F, with 105°F warming permitted only from the intended
   wake window. The policy already exists in source. Finish consistent delivery
   and verification across all command owners so a schedule or home integration
   cannot silently bypass it.

5. **Recording problems caught before bedtime — priority 1.** Extend current
   readiness checks into a practical warning when sensor freshness, repeated
   presence interruptions, processing or storage threatens the next recording.
   Give a specific next step and an inspected last-good time. Keep unobserved
   intervals unknown; do not improve the apparent sleep duration by filling gaps.

6. **A Watch recording assistant — priority 1.** Finish actual-device delivery
   of import receipts, per-source coverage and morning refresh opportunities.
   Show whether data has arrived and what the app cannot determine about missing
   permission or missing recordings. Preserve a user correction separately from
   measured stages. Success is recognizing a partial Watch night without calling
   it a complete three-hour sleep.

7. **A guided learning journey — priority 2.** The stage model, personal baseline
   and temperature learner should each say what they do, what is ready, and the
   next useful action. The guided screens are implemented in source; finish
   delivery and replace unsupported technical promises with visible evidence.
   Training completion and demonstrated improvement must remain distinct.

8. **Predictive temperature control — priority 2.** Build on the current local
   water-response research to anticipate the effect of a small target change.
   Compare against simple baselines on later, separate nights; then evaluate
   bounded proposals prospectively. A water forecast is not body temperature or
   proof of comfort. Keep language models focused on explanation and reviewed
   experiments while a deterministic controller enforces limits.

9. **Optional daytime context — priority 2.** Finish the consented native
   workout/activity import and learn whether workout timing, room conditions or
   selected day tags actually predict Luca's comfort. Retain source timestamps
   and unknown values. Do not automatically cool simply because a workout was
   recorded. Use nightly Watch temperature as historical context, not a live
   body-temperature measurement.

10. **Small personal comfort experiments — priority 2.** Compare two nearby
    settings while preserving the wake routine. Predefine duration, eligible
    nights, order, stop conditions and the decision rule. Judge morning comfort,
    unwanted interventions and usable observations, with a clear keep/revert
    decision. This turns model suggestions into something testable on this bed.

11. **Habit discoveries with enough context — priority 2.** The new journal
    already distinguishes timing, quantity, reported absence and missing entries.
    Complete native delivery, then improve comparisons for season, room
    temperature and routine changes. Show the number of comparable nights and
    uncertainty next to each finding. An observed association should not become
    a claim that a habit caused better or worse sleep.

12. **A prominent morning brief — priority 2.** Report formatting is already
    implemented; the next improvement is three concise takeaways, a useful small
    comparison chart, coverage badges and one optional experiment on the main
    screen. Follow-up questions should use the same dated evidence. An older
    saved report must never be presented as a new analysis of last night.

13. **An explanation for every meaningful adjustment — priority 1.** Deliver
    the source-backed overnight timeline, then join qualified home-action
    receipts to it. A tap should answer why the bed warmed, stayed at 70°F or
    withheld a proposal. Keep requested targets, reported temperatures, manual
    actions and Preview decisions distinct. Existing logs should become an
    understandable story without inventing causality.

14. **One clear wake-up plan — priority 1.** Finish the simplified editor and
    show the actual next occurrence in one sentence, including warming, target,
    vibration time and duration. The app-owned phone backup is separate and
    requires system authorization and readback. Later, add individually verified
    light/shade steps. Apple's AlarmKit supports app-owned alarms; it does not
    establish control over arbitrary alarms in Clock.

15. **Sleep in tomorrow — priority 2.** Offer one reviewable change for a single
    occurrence. Preview the Pod, app-owned phone backup and each supported wake
    accessory, then show separate acknowledgments and partial failures. Preserve
    the recurring weekday plan. An optional late Friday/Saturday prompt should
    be quiet when a partner is resting and should not silently change alarms.

16. **Finish Marissa's independent account — priority 1.** Complete invitation,
    sign-in, personal settings, schedule publication and reviewed side assignment.
    Her preferences and Health data must stay separate from Luca's. Preserve
    historical attribution through the eventual Marissa-left/Luca-right move.
    Until explicit activation, keep Luca's solo-anywhere arrangement.

17. **Partner-aware quiet and temporary arrangements — priority 2.** Add
    partner-resting, guest-night and temporary side-swap choices. Shared lights,
    speakers and whole-bed movement need household rules. Ambiguous occupancy
    must not train the wrong person's model. The bed's occupied side alone is
    insufficient evidence of who is there.

18. **Onboarding through practice — priority 2.** Reuse Marissa's illustrated
    guide as short in-app lessons: set a temperature, change tomorrow's alarm,
    stop an action and find a report. The practice mode must be unmistakable and
    incapable of operating the bed. Secure invitation and pairing should remove
    the need for her to handle IP addresses or the owner's connection key.

19. **A coordinated bedroom — priority 2.** Complete the existing disabled
    templates individually: dim approved lights already on, prepare shades,
    apply a supported purifier setting and respond to fresh room observations.
    Include manual holds, stale-data withdrawal and readable receipts. Preserve
    Homebridge/Apple Home pairings and reflect real device capabilities.

20. **An Endel bedtime ritual with visible audio state — priority 2.** Offer a
    user-selected soundscape, bedside destination, volume, duration and Stop.
    Validate the supported Shortcut/AirPlay path and show when a phone tap is
    required. AirPlay availability is not proof that a locked iPhone can complete
    every third-party audio action unattended. Keep the approved volume and
    partner quiet rules explicit.

21. **Everyday Watch, bedside and widget controls — priority 2.** Bring
    temperature, Stop and next wake to the Watch, ESP32 and Lock Screen/StandBy
    where supported. Use the same person/side mapping and freshness labels.
    A stale screen should never make an old state look live. Finish a small,
    dependable set of controls before expanding every diagnostic surface.

22. **A temporary I'm-too-hot action — priority 1.** The bounded cooling lease
    and feedback mechanism already exist in source. Complete delivery and make
    its duration, cancellation and return to the plan clear. A newer manual
    change must supersede restoration. The important outcome is an easy
    nighttime intervention that also becomes useful, correctly attributed
    comfort feedback.

23. **A practical bed-care center — priority 2.** Finish the current read-only
    care UI and make backup/recovery tasks understandable. Show real water,
    storage, sensor and service observations with their ages and appropriate
    actions. A server-side export is not yet an off-device backup. Do not imply
    that absent hardware sensors can detect leaks or worn maintenance inserts.

24. **Qualified base presets, then snoring assistance — priority 3.** Verify
    position reporting, small attended movements and Stop before expanding
    schedules. Then investigate a reliable snoring signal and partner-safe
    elevation. Treat Pod 4 whole-bed movement as shared unless proven otherwise.
    Newer Eight Sleep features do not establish that our hardware or firmware
    supports the same behavior.

## Highest-value acceptance order

Start with reliable access, the overnight comfort boundary, recording readiness,
clear waking and the two-person workflow. Improve the morning brief and personal
learning alongside those foundations. Home/audio/base actions need separate
qualification; remote software acknowledgments do not prove a physical result.

Relevant implementation references: [comfort limits](OVERNIGHT_COMFORT_LIMIT.md),
[response research](TARGET_RESPONSE_MODEL.md), [wake plan](CLEAR_WAKE_PLAN.md),
[recording readiness](RECORDING_READINESS.md), [night explanations](NIGHT_EXPLANATION.md),
[connection identity](CONTROLLER_CONNECTION_IDENTITY.md).

Platform references: [Apple AlarmKit](https://developer.apple.com/documentation/AlarmKit/scheduling-an-alarm-with-alarmkit),
[HomePod audio](https://support.apple.com/en-euro/guide/homepod/apdfb81a72e4/homepod).
Upstream foundations: [Free Sleep](https://github.com/throwaway31265/free-sleep),
[SleepyPod Core](https://github.com/sleepypod/core).
