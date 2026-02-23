#!/bin/bash
set -e

echo "========================================"
echo "  Restore WAN Internet Access"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root"
  exit 1
fi

# Flush iptables rules
iptables -F OUTPUT
iptables -P OUTPUT ACCEPT

# Save rules
if command -v iptables-save &> /dev/null; then
  iptables-save > /etc/iptables/rules.v4
fi

echo "Internet access restored!"
echo ""
