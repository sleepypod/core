/**
 * Manifest format for SleepyPod biometrics modules.
 *
 * Each module ships a manifest.json at its root. The core app reads these
 * to populate the system health page and track which modules are expected
 * to be running.
 *
 * The DB schema in biometrics-schema.ts is the actual data contract.
 * This manifest is metadata only — for discovery and health reporting.
 */
export interface ModuleManifest {
  /** Unique module identifier (kebab-case). Used as the systemd service component name. */
  name: string

  /** Semantic version string (e.g. "1.0.0") */
  version: string

  /** Short human-readable description shown in the UI */
  description: string

  /**
   * Specific fields this module writes, in "table.column" format.
   * Used to tell users what data they can expect from this module.
   * e.g. ["vitals.heartRate", "vitals.hrv", "vitals.breathingRate"]
   */
  provides: string[]

  /**
   * Top-level table names this module writes to.
   * Must be a subset of ["vitals", "sleep_records", "movement"].
   * e.g. ["vitals"]
   */
  writes: string[]

  /** Systemd unit name for this module's process (e.g. "sleepypod-piezo-processor.service") */
  service: string

  /** Primary implementation language — informational only */
  language: string

  /**
   * Minimum sleepypod-core version required for schema compatibility.
   * Modules should set this when the schema they depend on was introduced.
   * e.g. "1.2.0"
   */
  minVersion?: string
}
