'use client'

import { useEffect, useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { CheckCircle, Download, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'

/**
 * UpdateCard — shows current version and provides a trigger to update the pod software.
 *
 * Wires into:
 * - system.getVersion → shows running version/branch
 * - system.triggerUpdate → kicks off sp-update (service will restart)
 *
 * After triggering an update the service restarts, so the UI shows a
 * "reconnecting" state and polls until the server comes back.
 */
export function UpdateCard() {
  const version = trpc.system.getVersion.useQuery({})
  const triggerUpdate = trpc.system.triggerUpdate.useMutation()

  const [updateState, setUpdateState] = useState<'idle' | 'confirming' | 'updating' | 'reconnecting' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)

  // Clean up poll timer on unmount
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [])

  const versionData = version.data

  const handleUpdate = async () => {
    if (updateState === 'idle') {
      setUpdateState('confirming')
      return
    }

    if (updateState === 'confirming') {
      setUpdateState('updating')
      setErrorMessage(null)

      try {
        await triggerUpdate.mutateAsync({
          branch: versionData?.branch !== 'unknown' ? versionData?.branch : undefined,
        })
        setUpdateState('reconnecting')

        // Poll for reconnection — the service restarts after update
        pollForReconnection()
      }
      catch {
        // If the request fails immediately it might be because the service
        // already restarted (which is actually success)
        setUpdateState('reconnecting')
        pollForReconnection()
      }
    }
  }

  const pollForReconnection = () => {
    let attempts = 0
    const maxAttempts = 60 // ~2 minutes at 2s intervals

    const check = async () => {
      if (cancelledRef.current) return
      attempts++
      try {
        await version.refetch()
        // Success — service is back
        setUpdateState('idle')
      }
      catch {
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
    setErrorMessage(null)
  }

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2 sm:mb-3">
        {updateState === 'idle' || updateState === 'confirming'
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
                    {updateState === 'updating' ? 'Updating...' : 'Reconnecting...'}
                  </span>
                </>
              )}
      </div>

      {/* Version tags */}
      {versionData && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <VersionTag
            label={`v${versionData.commitHash !== 'unknown' ? versionData.commitHash.slice(0, 7) : '—'}`}
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

      {/* Confirmation prompt */}
      {updateState === 'confirming' && (
        <p className="mb-3 text-xs text-amber-400">
          This will download the latest code, rebuild, and restart the service. The pod will be briefly unavailable.
        </p>
      )}

      {/* Action buttons */}
      {(updateState === 'idle' || updateState === 'confirming' || updateState === 'error') && (
        <div className="flex gap-2">
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

          {updateState === 'confirming' && (
            <button
              onClick={handleCancel}
              className="rounded-lg border border-zinc-800 px-4 py-2.5 text-xs font-medium text-zinc-400 transition-colors active:bg-zinc-800"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Updating/reconnecting state */}
      {(updateState === 'updating' || updateState === 'reconnecting') && (
        <div className="flex items-center gap-2 rounded-lg bg-zinc-800/50 px-4 py-3">
          <Loader2 size={14} className="animate-spin text-sky-400" />
          <span className="text-xs text-zinc-400">
            {updateState === 'updating'
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
