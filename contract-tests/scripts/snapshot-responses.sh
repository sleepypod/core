#!/usr/bin/env bash
# Snapshot API REST responses into contract-tests/Tests/ContractTests/Fixtures/
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
FIXTURES_DIR="$(cd "$(dirname "$0")/../Tests/ContractTests/Fixtures" && pwd)"

mkdir -p "$FIXTURES_DIR"

fetch() {
  local name="$1"
  local path="$2"
  echo "  -> $name ($path)"
  curl -sf "${BASE_URL}${path}" -o "${FIXTURES_DIR}/${name}.json"
}

echo "Snapshotting API responses..."

# Healthcheck
fetch healthcheck /api/healthcheck

# System
fetch disk-usage /api/system/disk-usage
fetch internet-status /api/system/internet-status
fetch wifi-status /api/system/wifi-status

# Biometrics
fetch processing-status /api/biometrics/processing-status
fetch file-count /api/biometrics/file-count
fetch sleep-records "/api/biometrics/sleep-records?side=left"
fetch vitals "/api/biometrics/vitals?side=left"
fetch movement "/api/biometrics/movement?side=left"

# Health
fetch health-system /api/health/system
fetch health-scheduler /api/health/scheduler

echo "Done. Fixtures saved to $FIXTURES_DIR"
