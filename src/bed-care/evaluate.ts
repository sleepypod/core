import type { RecordingHealth } from '@/src/recording-health/contract'
import { CARE_MAX_AGE_MS, type BedCare, type CareCheck } from './contract'

export interface CareSources {
  now: number
  hardware: { at: number, water: 'low' | 'ok', priming: boolean } | null
  blockedSides: Array<'left' | 'right'> | null
  protectionEnabled: boolean | null
  recording: RecordingHealth | null
  lastExportAt: number | null
}

/** Translate measured facts into next steps; this function never controls the Pod. */
export function evaluateBedCare(input: CareSources): BedCare {
  const { now, hardware, recording } = input
  const currentHardware = hardware && Number.isSafeInteger(hardware.at) && hardware.at <= now && hardware.at >= now - CARE_MAX_AGE_MS ? hardware : null
  const currentRecording = recording && recording.generatedAt <= now && recording.generatedAt >= now - CARE_MAX_AGE_MS
    && recording.expiresAt > now
    ? recording
    : null
  const checks: CareCheck[] = []
  function add(check: Omit<CareCheck, 'expiresAt'>, sourceExpiry?: number) {
    checks.push({ ...check, expiresAt: check.observedAt === null ? null : Math.min(check.observedAt + CARE_MAX_AGE_MS, sourceExpiry ?? Infinity) })
  }
  add({ id: 'water', title: 'Water & priming', state: !currentHardware ? 'unknown' : currentHardware.water === 'low' ? 'attention' : currentHardware.priming ? 'busy' : 'checked',
    detail: !currentHardware ? 'No current water reading is available.' : currentHardware.water === 'low' ? 'The Pod reports low water.' : currentHardware.priming ? 'The Pod reports that priming is in progress.' : 'The Pod does not report low water. Priming is not running.',
    nextStep: !currentHardware ? 'Check the Pod connection before deciding whether to refill or prime.' : currentHardware.water === 'low' ? 'Follow the refill instructions for your exact Pod model. Inspect for visible wetness or kinked hoses if refills are unusually frequent.' : currentHardware.priming ? 'Let the current priming cycle finish; do not start another.' : 'No refill is indicated by this reading. Open thermal diagnostics if delivery feels wrong.',
    observedAt: currentHardware?.at ?? null, destination: 'thermal', evidence: [] })
  const blocked = input.blockedSides
  const protectionState = blocked?.length || input.protectionEnabled === false ? 'attention' : blocked === null || input.protectionEnabled === null ? 'unknown' : 'checked'
  add({ id: 'circulation', title: 'Circulation protection', state: protectionState,
    detail: blocked?.length ? `${blocked.map(side => side === 'left' ? 'Left' : 'Right').join(' and ')} has an active circulation protection.` : input.protectionEnabled === false ? 'Automatic pump-stall protection is turned off.' : protectionState === 'unknown' ? 'Protection settings or current state could not be verified.' : 'Protection is enabled and no active circulation protection is recorded. This does not verify pump flow or rule out a leak.',
    nextStep: blocked?.length ? 'Review the pump alert and its recovery instructions. This check does not dismiss protection or restart circulation.' : 'If you notice wetness, unusual noise or poor temperature delivery, inspect the bed and review thermal diagnostics.',
    observedAt: protectionState === 'unknown' ? null : now, destination: 'dashboard', evidence: [{ title: 'Automatic protection', detail: input.protectionEnabled === null ? 'The saved protection setting could not be read.' : input.protectionEnabled ? 'Enabled in the saved settings. This is not a physical pump test.' : 'Disabled in the saved settings. Review the protection settings before deciding whether to enable them; this page never changes them.' }] })
  const recordingChecks = currentRecording?.checks.filter(check => check.id !== 'storage') ?? []
  const recordingState = recordingChecks.some(check => check.state === 'attention') ? 'attention' : !recordingChecks.length || recordingChecks.some(check => check.state === 'unknown') ? 'unknown' : 'checked'
  add({ id: 'recording', title: 'Sensors & recording services', state: recordingState,
    detail: recordingState === 'attention' ? 'A recording source or processor needs attention.' : recordingState === 'unknown' ? 'Some recording sources have not been verified.' : 'The available sensor, processor and database checks passed. This does not establish sleep accuracy.',
    nextStep: 'Review the individual checks before changing calibration or restarting a service.', observedAt: currentRecording?.generatedAt ?? null, destination: 'health',
    evidence: recordingChecks.map(check => ({ title: check.title, detail: `${check.state === 'ok' ? 'Checked' : check.state === 'attention' ? 'Needs attention' : 'Not verified'}: ${check.detail}${check.nextStep ? ` ${check.nextStep}` : ''}` })) }, currentRecording?.expiresAt)
  const storage = currentRecording?.checks.find(check => check.id === 'storage')
  add({ id: 'storage', title: 'Recording storage', state: storage?.state === 'ok' ? 'checked' : storage?.state === 'attention' ? 'attention' : 'unknown',
    detail: storage?.detail ?? 'Space on the recording filesystem could not be checked.',
    nextStep: 'Review storage and preserve a backup before removing files. This check never deletes recordings.', observedAt: storage?.observedAt ?? null,
    destination: 'storage', evidence: [] }, currentRecording?.expiresAt)
  const exportAt = input.lastExportAt !== null && Number.isFinite(input.lastExportAt) && input.lastExportAt >= 0 && input.lastExportAt <= now ? Math.floor(input.lastExportAt) : null
  add({ id: 'backup', title: 'Backup & recovery', state: exportAt === null ? 'unknown' : 'checked',
    detail: exportAt === null ? 'No valid backup-export date is recorded.' : 'The server recorded a backup export. Download completion, an off-Pod copy and a successful restore are not verified.',
    nextStep: 'Download a current backup in Databases, keep it privately on another device, and verify the archive before maintenance.',
    observedAt: now, destination: 'databases', evidence: [] })
  return { apiVersion: 1, generatedAt: now, checks, lastExportAt: exportAt }
}
