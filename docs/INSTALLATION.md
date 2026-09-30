# First-time installation

If this is a stock Pod and you do not already have an administrator shell, start with **[Open your Pod and get root access](https://sleepypod.github.io/core/root-access/)**. The illustrated guide covers the parts, opening the enclosure, Tag-Connect wiring, interrupting boot, setting account passwords, joining Wi-Fi, and verifying SSH after installation.

## Pick the right access path

- **Pod 3 with an SD card:** use the separate SD-card procedure linked from the guide; back up the card first.
- **Pod 3 without an SD card, Pod 4, or Pod 5:** the documented serial path uses a TC2070-IDC harness, an FT232RL adapter with 3.3 V logic, and three signal wires. Match your board revision and connector orientation to the photos.
- **Pod 5:** complete initial setup in the Eight Sleep app first, as described in the current upstream procedure.

The serial console uses 921600 baud. The guide distinguishes commands for your computer, the U-Boot prompt, and the Pod's Linux shell. The documented boot arguments target slot A; do not substitute an unverified partition or save temporary boot arguments permanently.

Credit for the original bootstrap and wiring instructions belongs to [free-sleep](https://github.com/throwaway31265/free-sleep/blob/main/INSTALLATION.md). Installing free-sleep is not a prerequisite for sleepypod. Original sleepypod [Pod 5 photos](hardware/pod-5/) supplement that procedure.

## Continue from the root shell

Verify `id -u` returns `0` after a normal boot. Complete the guide's update-service and network preparation, then follow **[Install and update Core](https://sleepypod.github.io/core/installation/)**. Run the installer on the Pod from the serial console; you do not need to configure password SSH first.

The optional installer SSH step accepts your computer's **public** key and configures key-only access on port 8822. Keep the serial session available until a second terminal can connect successfully:

```bash
ssh -p 8822 root@POD_IP
```

Run `id -u` and `sp-status` in that new session, then shut down, disconnect power, remove the harness, and reassemble as described in the guide. Open `http://POD_IP:3000` on the same network and confirm the timezone and selected side.

For existing installations, see [deployment](DEPLOYMENT.md), [debugging](DEBUGGING.md), and the [script reference](../scripts/README.md).
