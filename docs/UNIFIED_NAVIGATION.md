# SleepyPod navigation

The current design follows the owner's updated SleepyPod direction. Phone tabs
are **Temp, Schedule, Sleep**, matching the active `lucaandrea/sleepypod-ios`
project. The older five-destination `free-sleep/ios` shell is not the active
native UI. Future parity checks must inspect `Sleepypod/SleepypodApp.swift`
in its own checkout rather than infer behavior from the original app.

On phones, Settings and the temperature-stage Settings shortcut keep Autopilot,
Home, System, owner connection controls and configured base controls accessible.
Desktop retains the direct SleepyPod sidebar. Existing `/more` bookmarks redirect
to Settings. Added Free Sleep capabilities use these existing surfaces.

The bottom tab bar grows with text size and safe-area insets. Its measured height
reserves content space and keeps the fixed 3D bed above the bar. Labels remain
unbroken and keyboard focus remains visible. Settings rows, segmented choices
and temperature-control previews wrap within the available width. Swipes follow the three primary
routes and do not hijack controls or the 3D stage.

Browser regression coverage checks secondary routes, owner sign-out, light/dark
appearance, 305px and 320px viewports at 200% text with scrollbar space, keyboard navigation and the bed/tab-bar
boundary. Fixed evening/morning clocks and preview scrubbing cover both edges
of the timeline; timestamp labels stay inside the plot and the long preview
button wraps when needed. Offline WebGL and the 2D fallback remain covered. The fallback uses normal
scroll flow, with its toolbar, both side controls and timeline in order rather
than fixed overlapping regions. This is
software/browser verification; it does not establish physical Pod behavior or
complete feature parity with the independent native implementation.
