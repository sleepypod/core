export interface LearningStep {
  title: string
  state: string
  description: string
  next: string
  progress?: { completed: number, required: number }
}

/** Fresh query receipts describe model inventory, not physical behavior or improved sleep. */
export function currentLearningRead(now: number | null, updatedAt: number, failed: boolean, fetching: boolean): boolean {
  return now !== null && !failed && !fetching && updatedAt > 0 && updatedAt <= now + 60_000 && now - updatedAt <= 300_000
}

export function stageLearning(model: { model: { version: string } | null, active: boolean } | undefined): LearningStep {
  return {
    title: 'Sleep-stage estimates',
    state: !model ? 'Needs a current read' : model.model ? model.active ? 'Pod model selected' : 'Candidate saved' : 'Rules are available',
    description: 'Estimates how a night was spent asleep. Matching Watch stages help compare a personal model; they are not clinical ground truth.',
    next: !model
      ? 'Refresh to check this side’s model. No training or selection happens automatically.'
      : model.model
        ? `Review ${model.model.version} and its held-out comparison before changing the selected estimator.`
        : 'On your iPhone, record complete nights with the Watch and Pod, review them, then compare training results with simpler estimates.',
  }
}

export function temperatureLearning(status: {
  completeNights: number
  requiredNights: number
  canTrain: boolean
  model: { current: boolean, validation: { passesFeedbackCheck: boolean } } | null
} | undefined): LearningStep {
  const valid = status && Number.isSafeInteger(status.completeNights) && status.completeNights >= 0
    && Number.isSafeInteger(status.requiredNights) && status.requiredNights > 0
  if (!valid) return { title: 'Temperature learning', state: 'Needs a current read',
    description: 'Learns from complete bed and room recordings paired with your comfort check-ins.',
    next: 'Refresh the Pod status to see what evidence is missing.' }
  const progress = { completed: status.completeNights, required: status.requiredNights }
  if (status.model) return { title: 'Temperature learning', progress,
    state: !status.model.current ? 'Recheck changed evidence' : status.model.validation.passesFeedbackCheck ? 'Research comparison passed' : 'Comparison needs improvement',
    description: 'Training and permission to control the bed are separate. A saved model does not enable overnight adjustments.',
    next: !status.model.current
      ? 'Review the changed nights and configuration before retraining.'
      : status.model.validation.passesFeedbackCheck
        ? 'Inspect Preview proposals and the independent hardware and reviewed-night activation requirements.'
        : 'Read the held-out comparison. Keep collecting useful nights; do not select a model just because it trained.',
  }
  return { title: 'Temperature learning', state: status.canTrain ? 'Ready to review a fit' : 'Collecting reviewed nights', progress,
    description: 'Learns from complete bed and room recordings paired with your comfort check-ins.',
    next: status.canTrain
      ? 'Review the included nights, train on the Pod, then inspect its comparison on later unseen nights.'
      : `Review complete nights and add a morning warm, cold or comfortable check-in. ${Math.max(0, status.requiredNights - status.completeNights)} more qualifying nights are needed for a fit. Health history alone cannot replace bed temperatures.`,
  }
}

export const baselineLearning: LearningStep = {
  title: 'Personal night baseline', state: 'Private on your iPhone',
  description: 'Describes your usual pattern and flags later nights that differ. It does not classify sleep stages or choose a bed temperature.',
  next: 'Open sleepypod on your iPhone → Sleep → Learning journey → Personal baseline. Choose one Health source, review genuine complete nights, then fit and verify the baseline. This browser cannot inspect the private model on your phone.',
}
