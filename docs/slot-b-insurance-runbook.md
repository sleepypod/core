# Slot B insurance: runbook

Status: **applied 2026-11-19** to the maintainer's Pod (MT8365, Slot A eMMC
layout, both slots on build `8df35cc8…` / 4.0.2) with
`scripts/bin/sp-neutralize-slot-b` (#942). The hand steps below are what the
script does, for a pod where the tree is not installed, and the fallback if
the script refuses. The draft of 2026-11-19 was reviewed against the current
`scripts/internet-control` before applying; the corrections are listed at the
end.

Goal: if U-Boot ever boots the other slot, we can SSH in and it does not
phone home. Nothing here touches U-Boot env, slot A, or the firmware
partition. Every write is to files inside a mounted `rootfs_b`.

## The layered position this fits into

| Layer | Survives slot switch | Survives factory reset | Survives stock OTA | Notes |
|---|---|---|---|---|
| 1. Network-level name block (Pi-hole / AdGuard / router wildcard on `8slp.net`) | yes | yes | yes | the only layer the pod cannot lose; per-network, not per-pod |
| 2. Slot B insurance (this runbook) | yes | no | no | keeps us in control after a fallback |
| 3. Slot A: masks, dnsmasq blackhole, confirmed boot counters | no | no | no | day-to-day protection; already in place |
| iptables on the pod | no | no | no | not a layer; convenience at best |

Layer 1 is the mitigation. Layer 2 is what makes a fallback a nuisance
instead of a brick-in-waiting. Apply the network-level block even when 2 and
3 are in place: it is the only one that is still there when the pod has
been reset to factory.

## The script

```bash
sudo sp-neutralize-slot-b status    # read-only: mounts the other slot ro, reports, unmounts
sudo sp-neutralize-slot-b           # apply (idempotent)
sudo sp-neutralize-slot-b undo      # back to stock
sudo sp-status                      # "boot slots" section: counters + "other slot: neutralized <date>"
```

It refuses when the pod does not boot from `rootfs_a`/`rootfs_b`, when
U-Boot's `current_slot` is not the running slot (the bootloader is about to
switch; sort that out first), when the other slot is already mounted, or
when the mount lands on a different device. It never calls `fw_setenv`.

## Pre-checks (read-only, all must hold)

```bash
ssh -p 8822 root@POD '
  grep -o "rootfs_[ab]" /proc/cmdline                      # must print rootfs_a
  fw_printenv current_slot boot_a_success retry_boot_a     # a / 1 / 5
  cat /proc/device-tree/model; echo                         # MT8365 Pumpkin
  lsblk -o NAME,PARTLABEL | grep -E "p5|p7"                 # p5=rootfs_a p7=rootfs_b
  mount | grep -c mmcblk0p7                                 # must print 0 (B not mounted)
  mkdir -p /mnt/slot_b && mount -o ro /dev/mmcblk0p7 /mnt/slot_b &&
  cat /mnt/slot_b/etc/rat_version && echo &&
  grep -E "^(PermitRootLogin|PasswordAuthentication|AllowUsers|AuthorizedKeysFile)" /mnt/slot_b/etc/ssh/sshd_config &&
  ls /mnt/slot_b/etc/systemd/system/ | grep -E "swupdate|defibrillator|eight-kernel" ;
  ls /mnt/slot_b/etc/systemd/system/multi-user.target.wants/ | grep dnsmasq ;
  umount /mnt/slot_b
'
```

Expected on this pod: `rootfs_a`, counters `a/1/5`, `MT8365 Pumpkin`, B is
`8df35cc8…`, stock sshd (`PermitRootLogin no`, `PasswordAuthentication no`,
`AllowUsers rewt`, `AuthorizedKeysFile /etc/ssh/authorized_keys
.ssh/authorized_keys`), only `swupdate.service.wants` in the unit dir (no
masks), and the stock `dnsmasq.service` enabled in B (slot A has it
disabled; it would take port 53 from the sleepypod resolver).

Stop if any of these differ. In particular stop if the running slot is not
`a`, or if `mount` shows p7 already mounted.

## Step 1: mount B read-write

```bash
mkdir -p /mnt/slot_b && mount -o rw /dev/mmcblk0p7 /mnt/slot_b
findmnt -n -o SOURCE /mnt/slot_b     # must print /dev/mmcblk0p7
```

## Step 2: SSH access (key in, root key login allowed)

B's socket-activated sshd (`sshd@.service`, `sshd -i`, no `-f`) reads
`/etc/ssh/sshd_config`; `sshd_config_readonly` is not used by any unit and is
left alone. Stock B lists `/etc/ssh/authorized_keys` first in
`AuthorizedKeysFile`; keep the file B's sshd actually reads. Do not point it
at `/home/root/ssh/…` (that is the slot A free-sleep path, and sshd on B
does not know it). The file is shared with `rewt`, and sshd opens it as the
logging-in user, so it stays `0644`; `/etc/ssh` keeps its stock mode.

```bash
install -d -m 755 /mnt/slot_b/etc/ssh
grep -v '^#' /home/root/ssh/authorized_keys | grep . >> /mnt/slot_b/etc/ssh/authorized_keys   # the keys that work on A today
chmod 644 /mnt/slot_b/etc/ssh/authorized_keys

cp -p /mnt/slot_b/etc/ssh/sshd_config /mnt/slot_b/etc/ssh/sshd_config.pre-neutralize
sed -i \
  -e 's/^PermitRootLogin .*/PermitRootLogin prohibit-password/' \
  -e 's/^AllowUsers rewt$/AllowUsers rewt root/' \
  /mnt/slot_b/etc/ssh/sshd_config
grep -E "^(PermitRootLogin|PasswordAuthentication|AllowUsers|AuthorizedKeysFile|Port)" /mnt/slot_b/etc/ssh/sshd_config
```

Expected: `Port 8822`, `PermitRootLogin prohibit-password`,
`PasswordAuthentication no`, `AllowUsers rewt root`, `AuthorizedKeysFile
/etc/ssh/authorized_keys .ssh/authorized_keys`. Password auth stays off in B.

Validate with slot A's own sshd against B's file. B has no host keys yet
(`sshdgenkeys` makes them at boot) and an empty `/dev`, so `chroot` does not
work; lend sshd a throwaway host key instead (no process started, nothing
listens):

```bash
d=$(mktemp -d); ssh-keygen -q -t ed25519 -N '' -f "$d/k"
sshd -t -h "$d/k" -f /mnt/slot_b/etc/ssh/sshd_config && echo "B sshd_config OK"
sshd -T -h "$d/k" -C user=root,host=localhost,addr=127.0.0.1 -f /mnt/slot_b/etc/ssh/sshd_config \
  | grep -E "^(permitrootlogin|allowusers|passwordauthentication|authorizedkeysfile)"
rm -rf "$d"
```

OpenSSH 8.9 prints `permitrootlogin without-password` (the old spelling of
`prohibit-password`) and one `allowusers` line per entry.

## Step 3: mask the stock units in B

The same eight units the installer masks on slot A (`scripts/lib/
telemetry-helpers`): telemetry shippers, the stock app, the updater, the
watchdog, the kernel-log shipper. Masking is a symlink to `/dev/null` in
`/etc/systemd/system/`; it takes precedence over the
`multi-user.target.wants` / `sockets.target.wants` enable links, so those
can stay.

```bash
for u in vector.service telegraf.service dac.service swupdate.socket swupdate.service swupdate-progress.service defibrillator.service eight-kernel.service; do
  ln -sfn /dev/null "/mnt/slot_b/etc/systemd/system/$u"
done
ls -l /mnt/slot_b/etc/systemd/system/ | grep -E "vector|telegraf|dac|swupdate|defibrillator|eight-kernel"
```

`defibrillator` is not optional: a stock slot without internet reboots
itself about every five minutes.

## Step 4: name blocking in B (dnsmasq NXDOMAIN, not /etc/hosts)

**Do not write `0.0.0.0` entries into B's `/etc/hosts`.** On Linux `0.0.0.0`
reaches the host itself: frank connects to the pod, gets EPIPE, retries every
few milliseconds and fills syslog until the pod runs out of memory (the
"frank retry storm" that made `internet-control hosts-block` an error on
`dev`). Names must be NXDOMAIN, which only the dnsmasq layer can answer.

The dnsmasq layer is the same four files slot A runs plus an enable link, and
it must be written offline: today's `dns-block` with `INTERNET_CONTROL_ROOT`
set still calls `systemctl` and the resolver checks against the live system.
`dns-install` is the offline variant.

```bash
INTERNET_CONTROL_ROOT=/mnt/slot_b /home/dac/sleepypod-core/scripts/internet-control dns-install
```

It writes `/etc/sleepypod/dnsmasq.conf`, `dns-resolv-hook`, `resolv.conf`,
`resolv.conf.orig-target` (B's `/etc/resolv.conf` target,
`/etc/resolv-conf.NetworkManager`), and
`/etc/systemd/system/sleepypod-dns.service`, links the unit into
`multi-user.target.wants`, and removes the stock `dnsmasq.service` wants
link (it binds `*:53`; ours needs `127.0.0.1:53`; slot A has it disabled
too). B's `/etc/resolv.conf` is not repointed: the unit's own start hook
does that when B boots, after dnsmasq answers, and leaves the original
resolver in place if it does not.

Check: `diff /mnt/slot_b/etc/sleepypod/dnsmasq.conf /etc/sleepypod/dnsmasq.conf`
(identical), `/mnt/slot_b/usr/bin/dnsmasq --test
--conf-file=/mnt/slot_b/etc/sleepypod/dnsmasq.conf` (`syntax check OK`).

## Step 5: marker, sync, unmount

```bash
install -d /mnt/slot_b/etc/sleepypod
date -u +%FT%TZ > /mnt/slot_b/etc/sleepypod/slot-neutralized   # the marker sp-status reads (#942)
echo block > /mnt/slot_b/etc/sleepypod/firmware-updates
sync
umount /mnt/slot_b
mount | grep -c mmcblk0p7    # 0
```

The script writes more lines after the date (source and target builds,
whether it created `authorized_keys`, whether the stock `dnsmasq.service`
was enabled) so that `undo` can put things back exactly.

## Verify (read-only, from A)

```bash
mount -o ro /dev/mmcblk0p7 /mnt/slot_b
cut -c1-40 /mnt/slot_b/etc/ssh/authorized_keys; ls -l /mnt/slot_b/etc/ssh/authorized_keys   # 0644
grep -E "^(PermitRootLogin|AllowUsers)" /mnt/slot_b/etc/ssh/sshd_config
ls -l /mnt/slot_b/etc/systemd/system/ | grep -c "/dev/null"                   # 8
ls -l /mnt/slot_b/etc/systemd/system/multi-user.target.wants/ | grep -E "dnsmasq|sleepypod"   # only sleepypod-dns.service
grep -c 0.0.0.0 /mnt/slot_b/etc/hosts                                          # 0
cat /mnt/slot_b/etc/sleepypod/slot-neutralized
umount /mnt/slot_b
fw_printenv current_slot boot_a_success retry_boot_a boot_b_success retry_boot_b   # unchanged: a / 1 / 5 / 1 / 5
```

Result on this pod, 2026-11-19: all of the above as expected (re-applied after the mask list grew to eight).

Do **not** test by switching `current_slot` to `b`. That is the one write
that can leave the pod on the stock slot, and the only way back is another
env write from inside B. The insurance is there precisely so that a
fallback we did not choose is survivable.

## Rollback

`sudo sp-neutralize-slot-b undo`, or by hand:

```bash
mount -o rw /dev/mmcblk0p7 /mnt/slot_b
mv -f /mnt/slot_b/etc/ssh/sshd_config.pre-neutralize /mnt/slot_b/etc/ssh/sshd_config
rm -f /mnt/slot_b/etc/ssh/authorized_keys        # stock B had none
for u in vector.service telegraf.service dac.service swupdate.service swupdate.socket swupdate-progress.service defibrillator.service eight-kernel.service; do rm -f "/mnt/slot_b/etc/systemd/system/$u"; done
INTERNET_CONTROL_ROOT=/mnt/slot_b /home/dac/sleepypod-core/scripts/internet-control dns-uninstall
ln -sfn /lib/systemd/system/dnsmasq.service /mnt/slot_b/etc/systemd/system/multi-user.target.wants/dnsmasq.service
rm -rf /mnt/slot_b/etc/sleepypod
sync; umount /mnt/slot_b
```

## What this does not do, on purpose

- No change to U-Boot env (counters, `current_slot`, `bootdelay`).
- No change to the firmware partition (`mmcblk0p3`) used by the FR-button
  reset. That image stays factory-pure; layer 1 is what covers a reset pod.
- No `rewt` changes in B (stock hash, stock sudo). Tracked in #936.
- No sleepypod install in B, and no copy of frank/NATS binaries (the docs'
  "Synchronize Slot B" script does that; on this pod both slots are the
  same build). If B ever boots, the plan is SSH in, confirm the state, and
  switch back to A deliberately, not to run from B.

## Corrections to the 2026-11-19 draft

- Step 4 wrote `0.0.0.0` names into `/etc/hosts`. That is the frank retry
  storm; replaced by the offline dnsmasq layer (`dns-install`).
- B's stock `dnsmasq.service` is enabled and would take port 53; it is
  disabled in B (as it already is in A).
- `chroot /mnt/b sshd -t` cannot work (no host keys, empty `/dev` in B);
  validate with A's sshd, `-f` and a throwaway `-h` key.
- `/etc/ssh/authorized_keys` is shared with `rewt` and opened as that user:
  `0644`, not `0600`.
- Marker is `/etc/sleepypod/slot-neutralized` (the name #942 specifies), and
  `/etc/sleepypod/firmware-updates` is set to `block`.
- Mount point is `/mnt/slot_b`, matching the docs' sync script.
- Masks cover the same eight units slot A masks (vector, telegraf, dac
  added), not just the five update/watchdog units #942 listed.
- `apply` also leaves a copy of the marker at
  `/etc/sleepypod/other-slot-neutralized` on the running slot, which
  `sp-welcome` shows in its `slots` row without mounting B.
