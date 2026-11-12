'use client'

import { useState } from 'react'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { ownerExperimentWorkspace } from '@/src/comfort/experiments/ownerBrowser'
import { ComfortExperiments } from './ComfortExperiments'
import '@/public/guide/comfort-experiments.css'

export function OwnerComfortExperiments() {
  const [workspace] = useState(() => ownerExperimentWorkspace())
  const { unit } = useTemperatureUnit()
  return <ComfortExperiments workspace={workspace} unit={unit} />
}
