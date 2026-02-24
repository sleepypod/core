# SleepyPod Installation Scripts

Scripts for deploying SleepyPod to Eight Sleep Pod hardware.

## Prerequisites

- Pod 3 (no SD card), Pod 4, or Pod 5
- Root access via JTAG
- WiFi configured
- Software updates disabled

See main [installation guide](../docs/INSTALLATION.md) for hardware setup.

## Installation

Run on the pod:

```bash
curl -fsSL https://raw.githubusercontent.com/sleepypod/core/main/scripts/install.sh | sudo bash
```

This will:
1. Detect dac.sock location
2. Install Node.js 20 and pnpm
3. Clone the repository
4. Install dependencies
5. Build the application
6. Generate and initialize database (Drizzle ORM + better-sqlite3)
7. Create systemd service with auto-restart
8. Create CLI shortcuts
9. Start the scheduler for automated jobs

## CLI Commands

After installation:

- `sp-status` - View service status
- `sp-restart` - Restart SleepyPod service
- `sp-logs` - View live logs
- `sp-update` - Update to latest version

## Optional Configuration

### SSH Access (Port 8822)

```bash
sudo bash scripts/setup-ssh.sh
```

Then connect:
```bash
ssh root@<POD_IP> -p 8822
```

### Block WAN Internet

Block all internet except local network:

```bash
sudo bash scripts/block-internet.sh
```

To restore internet:
```bash
sudo bash scripts/unblock-internet.sh
```

## Service Management

```bash
# Status
systemctl status sleepypod

# Start/stop/restart
systemctl start sleepypod
systemctl stop sleepypod
systemctl restart sleepypod

# Logs
journalctl -u sleepypod -f

# Enable/disable auto-start
systemctl enable sleepypod
systemctl disable sleepypod
```

## Features

After installation, SleepyPod provides:

- **Temperature Scheduling** - Set temperature by day/time
- **Power Scheduling** - Daily on/off cycles with temperature
- **Alarm System** - Vibration alarms with temperature changes
- **System Automation** - Daily priming and reboot schedules
- **Hardware Control** - Direct DAC socket communication
- **Health Monitoring** - Scheduler status and hardware connectivity checks
- **Timezone Support** - Full timezone awareness for all schedules

## File Locations

- **Installation**: `/home/dac/sleepypod-core/`
- **Database**: `/persistent/sleepypod-data/sleepypod.db` (SQLite with Drizzle ORM)
- **Service**: `/etc/systemd/system/sleepypod.service`
- **Environment**: `/home/dac/sleepypod-core/.env`

## Troubleshooting

### Service won't start

Check logs:
```bash
sp-logs
```

Common issues:
- dac.sock path incorrect (check `/run/dac.sock` or `/var/run/dac.sock`)
- Port 3000 already in use
- Database initialization failed
- Scheduler failing to start (check timezone in database)

### Web interface not accessible

1. Check service is running: `sp-status`
2. Check firewall isn't blocking port 3000
3. Verify pod IP: `ip addr show wlan0`

### Database errors

Reset database:
```bash
cd /home/dac/sleepypod-core
rm /persistent/sleepypod-data/sleepypod.db
pnpm db:generate
pnpm db:push
sp-restart
```

## Updating

```bash
sp-update
```

Or manually:
```bash
cd /home/dac/sleepypod-core
git pull
pnpm install
pnpm db:generate
pnpm build
sp-restart
```
