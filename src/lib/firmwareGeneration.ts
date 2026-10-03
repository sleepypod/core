/**
 * Firmware-generation classifier for the sensor-data pipeline.
 *
 * Eight Sleep has shipped three ways of handing sensor frames to us, and a
 * fleet of sleepypods spans all of them at once:
 *
 *   - old shim      — `frank.sh` patched to `cd /persistent/biometrics` so
 *                     `*.RAW` spools land on our tmpfs (ADR-0018)
 *   - mid-era       — `frank.service` carries our `WorkingDirectory=` drop-in
 *                     instead of a shell patch
 *   - new (≥ Apr 2026) — no `*.RAW` files at all; frames publish to a local
 *                     NATS server with JetStream (docs/nats-frame-readers.md)
 *
 * The classification here mirrors the `biometrics pipeline` section of
 * `scripts/bin/sp-status` so the Settings card and the shell diagnostic agree.
 * It is a pure function of the observed signals: the collector that shells
 * out lives in the system router, where it is mockable.
 */

export type FirmwareGeneration
  = 'nats'
    | 'raw-tmpfs-shim'
    | 'raw-tmpfs-service'
    | 'raw-tmpfs-unverified'
    | 'raw-filesystem'

export type SensorTransport = 'nats' | 'raw'

/**
 * Each signal is `true` / `false` when observed, or `null` when the probe
 * itself was unavailable (no systemd, no `mountpoint`, macOS dev box).
 */
export interface FirmwareSignals {
  /** `systemctl show nats-server.service --property=LoadState` is loaded/masked. */
  natsUnitInstalled: boolean | null
  /** `systemctl is-active nats-server.service`. */
  natsServerActive: boolean | null
  /** `/persistent/jetstream` exists as a directory. */
  jetstreamDirPresent: boolean | null
  /** `mountpoint -q /persistent/biometrics`. */
  biometricsTmpfsMounted: boolean | null
  /** `/opt/eight/bin/frank.sh` contains `cd /persistent/biometrics`. */
  frankShimRoutesTmpfs: boolean | null
  /** `systemctl cat frank.service` contains `WorkingDirectory=/persistent/biometrics`. */
  frankServiceRoutesTmpfs: boolean | null
}

/**
 * Classify the pod's firmware generation from its installed footprint.
 *
 * NATS wins on installation identity, not liveness: an installed unit or a
 * JetStream store means new firmware even while the server is restarting
 * (same rule as `discoverSensorSource`). Only when none of those are seen do
 * we look at the `.RAW` routing variants, in the same order `sp-status` does.
 */
export function classifyFirmware(s: FirmwareSignals): FirmwareGeneration {
  if (s.natsUnitInstalled || s.jetstreamDirPresent || s.natsServerActive) return 'nats'
  if (s.biometricsTmpfsMounted) {
    if (s.frankShimRoutesTmpfs) return 'raw-tmpfs-shim'
    if (s.frankServiceRoutesTmpfs) return 'raw-tmpfs-service'
    return 'raw-tmpfs-unverified'
  }
  return 'raw-filesystem'
}

/**
 * True when at least one shell probe ran — i.e. we are on a pod with systemd.
 * A dev box answers `null` to every `systemctl` / `mountpoint` call; the
 * filesystem probes alone can't distinguish it from a `.RAW` pod.
 */
export function firmwareProbed(s: FirmwareSignals): boolean {
  return s.natsUnitInstalled !== null || s.natsServerActive !== null
    || s.biometricsTmpfsMounted !== null || s.frankServiceRoutesTmpfs !== null
}

/** Which frame source the stream *should* pick for a given generation. */
export function expectedTransport(generation: FirmwareGeneration): SensorTransport {
  return generation === 'nats' ? 'nats' : 'raw'
}

export const FIRMWARE_LABELS: Record<FirmwareGeneration, { label: string, detail: string }> = {
  'nats': {
    label: 'NATS JetStream',
    detail: 'New firmware (April 2026 and later) publishes sensor frames to a local NATS server instead of writing .RAW files.',
  },
  'raw-tmpfs-shim': {
    label: '.RAW on tmpfs (frank.sh shim)',
    detail: 'Old firmware. The patched frank.sh writes .RAW spools to the tmpfs at /persistent/biometrics.',
  },
  'raw-tmpfs-service': {
    label: '.RAW on tmpfs (frank.service)',
    detail: 'Mid-era firmware. A frank.service drop-in routes .RAW spools to the tmpfs at /persistent/biometrics.',
  },
  'raw-tmpfs-unverified': {
    label: '.RAW on tmpfs (routing unverified)',
    detail: 'The tmpfs is mounted, but neither frank.sh nor frank.service is known to write there. Check sp-status.',
  },
  'raw-filesystem': {
    label: '.RAW on /persistent',
    detail: 'Legacy or mid-era firmware writing .RAW spools straight to flash. No tmpfs is mounted.',
  },
}
