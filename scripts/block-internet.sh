#!/bin/bash
set -e

echo "========================================"
echo "  Block WAN Internet Access"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root"
  exit 1
fi

# Get local network interface and subnet
INTERFACE="wlan0"
LOCAL_SUBNET=$(ip -4 addr show "$INTERFACE" | grep -oP '(?<=inet\s)\d+(\.\d+){2}\.0/\d+')

echo "Interface: $INTERFACE"
echo "Local subnet: $LOCAL_SUBNET"
echo ""

# Install iptables if not present
if ! command -v iptables &> /dev/null; then
  echo "Installing iptables..."
  apt-get update
  apt-get install -y iptables iptables-persistent
fi

# Flush existing rules
iptables -F OUTPUT

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT

# Allow local network
iptables -A OUTPUT -d "$LOCAL_SUBNET" -j ACCEPT

# Block all other outbound traffic
iptables -A OUTPUT -j DROP

# Save rules
iptables-save > /etc/iptables/rules.v4

echo ""
echo "Internet access blocked!"
echo "Local network ($LOCAL_SUBNET) is still accessible."
echo ""
echo "To restore internet: bash $(dirname "$0")/unblock-internet.sh"
echo ""
