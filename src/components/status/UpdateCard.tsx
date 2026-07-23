'use client'

import { useEffect, useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { CheckCircle, Download, Loader2, RefreshCw, AlertTriangle, Globe } from 'lucide-react'

/**
 * UpdateCard — shows current version and provides a trigger to update the pod software.
 *
 * Wires into:
 * - system.getVersion → shows running version/branch
 * - system.triggerUpdate → kicks off sp-update (service will restart)
 * - system.internetStatus → checks if WAN is blocked
 * - sp-update → temporarily opens WAN without changing the persisted policy
 *
 * After triggering an update the service restarts, so the UI shows a
 * "reconnecting" state and polls until the server comes back.
 *
 * If internet is blocked when the user initiates an update, the card asks for
 * confirmation. The updater itself opens WAN only for the download and
 * restores the captured mode before restarting the app.
 */
export function UpdateCard() {
  const utils = trpc.useUtils()
  const version = trpc.system.getVersion.useQuery({})
  const triggerUpdate = trpc.system.triggerUpdate.useMutation()

  const [updateState, setUpdateState] = useState<
    'idle' | 'confirming' | 'branch-picker' | 'internet-prompt' | 'unblocking' | 'updating' | 'reconnecting' | 'error'
  >('idle')
  const [selectedBranch, setSelectedBranch] = useState<string | undefined>(undefined)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)
  /**
   * Version snapshot captured right before sp-update runs. Polling uses
   * this to distinguish "service is still the old build" from "service
   * restarted on the new build" — without it, the first poll racily
   * succeeds against the still-running old service and the UI reports a
   * completed update while the download is still in progress.
   */
  const baselineVersionRef = useRef<{ commitHash: string, buildDate: string } | null>(null)
  /** Set to true once a poll fails — proves the service actually went down. */
  const sawDownRef = useRef(false)

  // Clean up the reconnect poll on unmount. Firewall recovery belongs to the
  // root updater, so navigating away cannot strand the pod in a temporary mode.
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [])

  const versionData = version.data
  const isStandardBranch = versionData?.branch === 'main' || versionData?.branch === 'dev'

  const handleUpdate = async () => {
    if (updateState === 'idle') {
      // No version data yet — do nothing
      if (!versionData) return
      // Non-standard branch → let user pick main or dev first
      if (!isStandardBranch) {
        setUpdateState('branch-picker')
        return
      }
      setUpdateState('confirming')
      return
    }

    if (updateState === 'confirming') {
      setErrorMessage(null)

      // Check if internet is blocked before proceeding
      try {
        const status = await utils.system.internetStatus.fetch({})
        if (status.blocked) {
          setUpdateState('internet-prompt')
          return
        }
      }
      catch {
        // If we can't check, proceed anyway — the update script handles its own connectivity
      }

      await startUpdate()
    }
  }

  const handleBranchSelected = (branch: string) => {
    setSelectedBranch(branch)
    setUpdateState('confirming')
  }

  /** Confirm that the updater may temporarily open WAN, then proceed. */
  const handleAllowInternet = async () => {
    setUpdateState('unblocking')
    setErrorMessage(null)
    await startUpdate()
  }

  /** Trigger the actual update */
  const startUpdate = async () => {
    setUpdateState('updating')

    const branch = selectedBranch
      ?? (versionData?.branch !== 'unknown' ? versionData?.branch : undefined)

    // Snapshot the current build so polling can tell when sp-update has
    // actually restarted the service on the new code (vs. the old service
    // still serving the API mid-download).
    baselineVersionRef.current = versionData
      ? { commitHash: versionData.commitHash, buildDate: versionData.buildDate }
      : null
    sawDownRef.current = false

    try {
      await triggerUpdate.mutateAsync({ branch })
      setUpdateState('reconnecting')
      pollForReconnection()
    }
    catch {
      // The request can be cut off as the service stops. Polling verifies the
      // resulting build identity instead of guessing success from disconnect.
      setUpdateState('reconnecting')
      pollForReconnection()
    }
  }

  const pollForReconnection = () => {
    let attempts = 0
    const maxAttempts = 90 // ~3 minutes at 2s intervals — sp-update can stay up for a while before stopping the service

    const check = async () => {
      if (cancelledRef.current) return
      attempts++
      try {
        // Use the direct fetch path so a network/server error throws
        // cleanly — useQuery.refetch() resolves on error and would make
        // the down-detection below silently false.
        const next = await utils.system.getVersion.fetch({})

        const baseline = baselineVersionRef.current
        const versionChanged = baseline !== null
          && (next.commitHash !== baseline.commitHash || next.buildDate !== baseline.buildDate)

        // Only call this "done" after the build identity changes. A failed
        // update also bounces the service while rolling back to the previous
        // build, so a reconnect by itself is not proof of success.
        if (versionChanged) {
          // Keep the React-Query cache in sync with what we just fetched
          // so other consumers re-render with the new version.
          utils.system.getVersion.setData({}, next)
          setUpdateState('idle')
          return
        }

        if (sawDownRef.current) {
          setUpdateState('error')
          setErrorMessage('Service restarted but the version did not change. The update may have rolled back; check logs.')
          return
        }

        // Old service is still up; sp-update hasn't reached `systemctl
        // stop` yet. Keep polling until the updater performs the bounce.
        if (attempts < maxAttempts && !cancelledRef.current) {
          pollTimerRef.current = setTimeout(check, 2000)
        }
        else if (!cancelledRef.current) {
          setUpdateState('error')
          setErrorMessage('Service did not restart on a new build. Check pod manually.')
        }
      }
      catch {
        sawDownRef.current = true
        if (attempts < maxAttempts && !cancelledRef.current) {
          pollTimerRef.current = setTimeout(check, 2000)
        }
        else if (!cancelledRef.current) {
          setUpdateState('error')
          setErrorMessage('Service did not come back after update. Check pod manually.')
        }
      }
    }

    // Wait a few seconds before first poll to give the service time to stop
    pollTimerRef.current = setTimeout(check, 5000)
  }

  const handleCancel = () => {
    setUpdateState('idle')
    setSelectedBranch(undefined)
    setErrorMessage(null)
  }

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2 sm:mb-3">
        {updateState === 'idle' || updateState === 'confirming' || updateState === 'branch-picker' || updateState === 'internet-prompt'
          ? (
              <>
                <CheckCircle size={16} className="text-emerald-400" />
                <span className="text-sm font-medium text-white">Software</span>
              </>
            )
          : updateState === 'error'
            ? (
                <>
                  <AlertTriangle size={16} className="text-red-400" />
                  <span className="text-sm font-medium text-white">Update Failed</span>
                </>
              )
            : (
                <>
                  <Loader2 size={16} className="animate-spin text-sky-400" />
                  <span className="text-sm font-medium text-white">
                    {updateState === 'unblocking'
                      ? 'Enabling internet...'
                      : updateState === 'updating'
                        ? 'Updating...'
                        : 'Reconnecting...'}
                  </span>
                </>
              )}
      </div>

      {/* Version tags */}
      {versionData && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <VersionTag
            label={versionData.commitHash !== 'unknown' ? versionData.commitHash.slice(0, 7) : '—'}
            color="emerald"
          />
          <span className="text-xs text-zinc-600">on</span>
          <VersionTag
            label={versionData.branch !== 'unknown' ? versionData.branch : '—'}
            color="zinc"
          />
        </div>
      )}

      {version.isLoading && (
        <div className="flex items-center gap-2 py-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
          <span className="text-xs text-zinc-500">Loading version...</span>
        </div>
      )}

      {/* Error message */}
      {errorMessage && (
        <p className="mb-3 text-xs text-red-400">{errorMessage}</p>
      )}

      {/* Branch picker for non-standard branches */}
      {updateState === 'branch-picker' && (
        <div className="mb-3">
          <p className="mb-2 text-xs text-amber-400">
            {`Current branch (${versionData?.branch}) is not a release channel. Pick a channel to update to:`}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => handleBranchSelected('main')}
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-800/50 px-4 py-2.5 text-xs font-medium text-emerald-400 transition-colors active:bg-zinc-700"
            >
              main
            </button>
            <button
              onClick={() => handleBranchSelected('dev')}
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-800/50 px-4 py-2.5 text-xs font-medium text-sky-400 transition-colors active:bg-zinc-700"
            >
              dev
            </button>
            <button
              onClick={handleCancel}
              className="rounded-lg border border-zinc-800 px-4 py-2.5 text-xs font-medium text-zinc-400 transition-colors active:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Confirmation prompt */}
      {updateState === 'confirming' && (
        <p className="mb-3 text-xs text-amber-400">
          {selectedBranch
            ? `This will switch to ${selectedBranch}, rebuild, and restart the service. The pod will be briefly unavailable.`
            : 'This will download the latest code, rebuild, and restart the service. The pod will be briefly unavailable.'}
        </p>
      )}

      {/* Internet blocked prompt */}
      {updateState === 'internet-prompt' && (
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2">
            <Globe size={14} className="text-amber-400" />
            <p className="text-xs text-amber-400">
              Internet is currently blocked. Temporarily allow internet to check for updates?
            </p>
          </div>
          <p className="text-[10px] text-zinc-500">
            Internet will be re-blocked automatically after the update completes.
          </p>
        </div>
      )}

      {/* Action buttons */}
      {(updateState === 'idle' || updateState === 'confirming' || updateState === 'error' || updateState === 'internet-prompt') && (
        <div className="flex gap-2">
          {updateState === 'internet-prompt'
            ? (
                <button
                  onClick={handleAllowInternet}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800/50 px-4 py-2.5 text-xs font-medium text-amber-400 transition-colors active:bg-zinc-700"
                >
                  <Globe size={14} />
                  Allow &amp; Update
                </button>
              )
            : (
                <button
                  onClick={handleUpdate}
                  disabled={version.isLoading}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800/50 px-4 py-2.5 text-xs font-medium text-sky-400 transition-colors active:bg-zinc-700 disabled:opacity-50"
                >
                  {updateState === 'confirming'
                    ? (
                        <>
                          <Download size={14} />
                          Confirm Update
                        </>
                      )
                    : updateState === 'error'
                      ? (
                          <>
                            <RefreshCw size={14} />
                            Retry Update
                          </>
                        )
                      : (
                          <>
                            <RefreshCw size={14} />
                            Check for Updates
                          </>
                        )}
                </button>
              )}

          {(updateState === 'confirming' || updateState === 'internet-prompt') && (
            <button
              onClick={handleCancel}
              className="rounded-lg border border-zinc-800 px-4 py-2.5 text-xs font-medium text-zinc-400 transition-colors active:bg-zinc-800"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Unblocking/updating/reconnecting state */}
      {(updateState === 'unblocking' || updateState === 'updating' || updateState === 'reconnecting') && (
        <div className="flex items-center gap-2 rounded-lg bg-zinc-800/50 px-4 py-3">
          <Loader2 size={14} className="animate-spin text-sky-400" />
          <span className="text-xs text-zinc-400">
            {updateState === 'unblocking'
              ? 'Enabling internet access...'
              : updateState === 'updating'
                ? 'Triggering update...'
                : 'Waiting for service to restart...'}
          </span>
        </div>
      )}
    </div>
  )
}

function VersionTag({ label, color }: { label: string, color: 'emerald' | 'zinc' }) {
  const colorClasses
    = color === 'emerald'
      ? 'bg-emerald-500/15 text-emerald-400'
      : 'bg-zinc-800 text-zinc-400'

  return (
    <span className={`rounded-md px-2 py-1 text-xs font-medium ${colorClasses}`}>
      {label}
    </span>
  )
}
