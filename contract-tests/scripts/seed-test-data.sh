#!/usr/bin/env bash
# Seed biometrics DB with test rows so contract tests get non-empty responses.
# Timestamps are unix epoch (seconds) — matching the integer column mode in the schema.
set -euo pipefail

DB_PATH="${BIOMETRICS_DB_PATH:-biometrics.dev.db}"

echo "Seeding test data into $DB_PATH ..."

# 2026-01-15T02:00:00Z = 1768449600
# 2026-01-15T02:05:00Z = 1768449900
# 2026-01-15T02:10:00Z = 1768450200
# 2026-01-15T00:30:00Z = 1768444200
# 2026-01-15T07:30:00Z = 1768469400

sqlite3 "$DB_PATH" <<'SQL'
-- Vitals
INSERT OR IGNORE INTO vitals (id, side, timestamp, heart_rate, hrv, breathing_rate)
VALUES
  (1, 'left', 1768449600, 62, 45, 14),
  (2, 'left', 1768449900, 60, 48, 13),
  (3, 'left', 1768450200, 58, 50, 13);

-- Sleep records
INSERT OR IGNORE INTO sleep_records (id, side, entered_bed_at, left_bed_at, sleep_duration_seconds, times_exited_bed, created_at)
VALUES
  (1, 'left', 1768444200, 1768469400, 25200, 1, 1768469400);

-- Movement
INSERT OR IGNORE INTO movement (id, side, timestamp, total_movement)
VALUES
  (1, 'left', 1768449600, 12),
  (2, 'left', 1768449900, 5),
  (3, 'left', 1768450200, 8);
SQL

echo "Done."
