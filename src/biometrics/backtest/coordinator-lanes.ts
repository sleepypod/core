import type { CoordinatorTask } from './coordinator-tasks'
export type CoordinatorLane = 'read' | 'work'
export const coordinatorTaskLanes: Record<CoordinatorTask['type'], CoordinatorLane> = {
  readShadowReport: 'read',
  pageRawSources: 'read', datasetDescriptor: 'read', exportDataset: 'read', readResult: 'read', readSummary: 'read', readTrace: 'read', readNumericTrace: 'read', readReferenceTrace: 'read',
  createWaveformDataset: 'work', inspectRawSource: 'work', createDataset: 'work', releaseDataset: 'work',
  releaseResult: 'work', createExperiment: 'work', collectArtifacts: 'work', execute: 'work',
}
