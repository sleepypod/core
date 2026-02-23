#!/bin/bash
set -e

echo "========================================"
echo "  SleepyPod SSH Configuration"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root"
  exit 1
fi

# Configure SSH on alternate port
SSH_PORT=8822

echo "Configuring SSH on port $SSH_PORT..."

# Backup original sshd_config
if [ ! -f /etc/ssh/sshd_config.backup ]; then
  cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup
fi

# Update SSH configuration
sed -i "s/#Port 22/Port $SSH_PORT/" /etc/ssh/sshd_config
sed -i "s/Port 22/Port $SSH_PORT/" /etc/ssh/sshd_config
sed -i "s/#PermitRootLogin prohibit-password/PermitRootLogin yes/" /etc/ssh/sshd_config
sed -i "s/PermitRootLogin prohibit-password/PermitRootLogin yes/" /etc/ssh/sshd_config

# Add public key
echo ""
echo "Enter your SSH public key (or press Enter to skip):"
read -r SSH_KEY

if [ -n "$SSH_KEY" ]; then
  mkdir -p /root/.ssh
  echo "$SSH_KEY" >> /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  echo "SSH key added successfully!"
fi

# Restart SSH service
systemctl restart sshd

echo ""
echo "SSH configured successfully!"
echo "Port: $SSH_PORT"
echo ""
echo "Connect with: ssh root@<POD_IP> -p $SSH_PORT"
echo ""
