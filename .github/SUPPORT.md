# Getting Help

Help us help you fast. Requests that include the four things below get answered
much quicker — whether you're posting in Discord or opening a GitHub issue.

> **Don't DM maintainers for support, and don't report bugs *only* in chat.**
> Public channels let everyone learn from the answer; GitHub issues keep bugs
> from getting lost. If you've found a bug, open an issue with the details below.

## 1. What hardware are you on?

- **Pod model:** Pod 3 / Pod 4 / Pod 5
- **Cover variant** (vibration/alarm): yes / no
- **System software version:** open the web UI → **Status** page; the version
  (branch + commit) is shown at the bottom. Paste that exact string.

## 2. Have you ever installed free-sleep on this pod? (yes / no)

This matters more than you'd expect. A leftover free-sleep install keeps its own
services running and competes with sleepypod for control of the hardware — it's a
top cause of "my pod does X and won't stop." If yes, say so up front, even if you
believe you removed it.

## 3. Grab your logs (no SSH needed)

- Open `http://<your-pod-ip>:3000/` → **Status** page → **System Logs**.
- Pick a service from the dropdown (start with **Core**), set the filter to
  **All**, and copy the last ~100 lines.
- Firmware acting up? The same page has the **Firmware Log** console — copy from
  there too.
- Comfortable with SSH? Connect on port 8822, then run `sp-logs` (live stream) or
  `sp-status` (current service state).

## 4. How to share logs

- ✅ Paste short logs directly in a fenced code block, or attach them as plain
  **`.txt` / `.log`** files.
- ❌ **Do not upload `.zip` / `.gz` / tarballs.** We can't preview or search
  inside them and they tend to get skipped. If you have several log files,
  **extract them and upload each file individually.**

---

Found a bug? After sharing the above, please also open a
[GitHub issue](../../issues/new) with reproduction steps so it doesn't get lost
in chat history.
