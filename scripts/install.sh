#!/bin/bash
set -e

echo "========================================"
echo "  SleepyPod Core Installation Script"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root (use sudo)"
  exit 1
fi

# Detect dac.sock path
echo "Detecting dac.sock path..."
DAC_SOCK_PATH=""

if [ -S "/run/dac.sock" ]; then
  DAC_SOCK_PATH="/run/dac.sock"
elif [ -S "/var/run/dac.sock" ]; then
  DAC_SOCK_PATH="/var/run/dac.sock"
else
  echo "Warning: dac.sock not found. Please specify manually."
  read -p "Enter dac.sock path: " DAC_SOCK_PATH
fi

echo "Using dac.sock at: $DAC_SOCK_PATH"

# Create data directory
DATA_DIR="/persistent/sleepypod-data"
echo "Creating data directory at $DATA_DIR..."
mkdir -p "$DATA_DIR"
chmod 755 "$DATA_DIR"

# Install Node.js if not present
if ! command -v node &> /dev/null; then
  echo "Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Install pnpm if not present
if ! command -v pnpm &> /dev/null; then
  echo "Installing pnpm..."
  npm install -g pnpm
fi

# Clone or update repository
INSTALL_DIR="/home/dac/sleepypod-core"
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull
else
  echo "Cloning repository..."
  git clone https://github.com/sleepypod/core.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install dependencies
echo "Installing dependencies..."
pnpm install

# Build application
echo "Building application..."
pnpm build

# Create environment file
echo "Creating environment file..."
cat > "$INSTALL_DIR/.env" << EOF
DATABASE_URL=file:$DATA_DIR/sleepypod.db
DAC_SOCK_PATH=$DAC_SOCK_PATH
NODE_ENV=production
EOF

# Initialize database
echo "Generating database schema..."
pnpm db:generate

echo "Creating database and tables..."
pnpm db:push

# Create systemd service
echo "Creating systemd service..."
cat > /etc/systemd/system/sleepypod.service << EOF
[Unit]
Description=SleepyPod Core Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
Environment="NODE_ENV=production"
Environment="DATABASE_URL=file:$DATA_DIR/sleepypod.db"
Environment="DAC_SOCK_PATH=$DAC_SOCK_PATH"
ExecStart=/usr/bin/pnpm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable service
echo "Enabling service..."
systemctl daemon-reload
systemctl enable sleepypod.service
systemctl restart sleepypod.service

# Create CLI shortcuts
echo "Creating CLI shortcuts..."
cat > /usr/local/bin/sp-status << 'EOF'
#!/bin/bash
systemctl status sleepypod.service
EOF

cat > /usr/local/bin/sp-restart << 'EOF'
#!/bin/bash
systemctl restart sleepypod.service
EOF

cat > /usr/local/bin/sp-logs << 'EOF'
#!/bin/bash
journalctl -u sleepypod.service -f
EOF

cat > /usr/local/bin/sp-update << 'EOF'
#!/bin/bash
set -e
echo "Updating SleepyPod..."
cd /home/dac/sleepypod-core
git pull
pnpm install
pnpm db:generate
pnpm build
systemctl restart sleepypod.service
echo "✓ Update complete!"
EOF

chmod +x /usr/local/bin/sp-*

# Get pod IP address
POD_IP=$(ip -4 addr show wlan0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}')

# Wait for service to start and check health
echo "Waiting for service to start..."
sleep 5

if systemctl is-active --quiet sleepypod.service; then
  SERVICE_STATUS="✓ Running"
else
  SERVICE_STATUS="✗ Failed (check logs with: sp-logs)"
fi

echo ""
echo "========================================"
echo "  Installation Complete!"
echo "========================================"
echo ""
echo "Service Status: $SERVICE_STATUS"
echo ""
echo "Web Interface: http://$POD_IP:3000/"
echo ""
echo "Features:"
echo "  • Temperature & Power Scheduling"
echo "  • Alarm Management"
echo "  • Hardware Control via DAC socket"
echo "  • Automated job scheduler with timezone support"
echo ""
echo "CLI Commands:"
echo "  sp-status   - View service status"
echo "  sp-restart  - Restart service"
echo "  sp-logs     - View live logs"
echo "  sp-update   - Update to latest version"
echo ""
echo "Files:"
echo "  Database: $DATA_DIR/sleepypod.db"
echo "  Config:   $INSTALL_DIR/.env"
echo "  Logs:     journalctl -u sleepypod.service"
echo ""
