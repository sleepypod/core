import { installHardwareAdmission, type HardwareAdmissionSnapshot } from '../admission'

/** An explicit isolated admission source for hardware protocol tests. */
export function admissionFixture() {
  let snapshot: HardwareAdmissionSnapshot = { revision: 1, holdId: null }
  const uninstall = installHardwareAdmission({ read: () => snapshot })
  return { uninstall, set(next: HardwareAdmissionSnapshot) {
    snapshot = next
  } }
}
