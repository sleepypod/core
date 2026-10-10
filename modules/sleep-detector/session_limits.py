"""
Session limits shared by the detector (main.py) and
scripts/repair-capped-sessions.py, which must agree on them. No imports and
no side effects, so the repair script can load it without the detector's
runtime dependencies.
"""

# Seconds of continuous absence before we consider the user has left bed
ABSENCE_TIMEOUT_S = 120
# Minimum session length to record (filters out accidental detections)
MIN_SESSION_S = 300
# Hard upper bound on a single session. Belt-and-suspenders against a session
# that never closes (e.g. presence flapping that historically kept resetting
# the absence timer, producing 2736/2850min runaway durations). A continuous
# presence span beyond this is force-closed at the cap rather than persisted as
# a multi-day sleep_record.
MAX_SESSION_S = 16 * 3600
