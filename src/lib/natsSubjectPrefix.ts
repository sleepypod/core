/**
 * `device_settings.nats_subject_prefix`: the NATS subject prefix the sensor
 * readers subscribe under (`<prefix>.sens.>`, `<prefix>.frz.>`). Shared by the
 * settings router, the Node reader and the Settings card; keep the pattern in
 * sync with `NATS_SUBJECT_PREFIX_RE` in modules/common/nats_follower.py.
 */

/** One subject token: no dots or wildcards, so a pin can never widen the subscription. */
export const NATS_SUBJECT_PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function isNatsSubjectPrefix(value: unknown): value is string {
  return typeof value === 'string' && NATS_SUBJECT_PREFIX_PATTERN.test(value)
}
