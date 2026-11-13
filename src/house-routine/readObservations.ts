import { buildHouseRoutineObservations, HouseRoutineObservationsUnavailable } from './observations'

/** Existing readers only. This endpoint never starts services or changes the house/Pod configuration. */
export async function readHouseRoutineObservations() {
  const [{ sqlite }, { getComfortOwner }] = await Promise.all([
    import('@/src/db'), import('@/src/comfort/instance'),
  ])
  return sqlite.transaction(() => {
    const configuration = sqlite.prepare('SELECT bed_mode, unused_zone_mode FROM device_settings ORDER BY id LIMIT 1')
      .get() as { bed_mode: string, unused_zone_mode: string } | undefined
    // House Control's delivered v1 adapter consumes logical Left. A shared bed
    // needs separate consent/identity support; changing sides must not silently remap it.
    if (configuration?.bed_mode !== 'solo-left' || configuration.unused_zone_mode !== 'follow') {
      throw new HouseRoutineObservationsUnavailable()
    }
    return buildHouseRoutineObservations(getComfortOwner().presenceEvidence('left'))
  })()
}
