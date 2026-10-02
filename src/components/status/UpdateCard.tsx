'use client'

import { useEffect, useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Download, Globe, RefreshCw } from 'lucide-react'
import { Alert, Button, Card, CardHeader, KeyValue, SegmentedControl, SettingRow, Skeleton, StatusDot } from '@/src/components/ds'

type Channel = 'main' | 'dev'

export function formatBuildDate(dateStr: string, withTime = false): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: withTime ? undefined : 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  })
}

/**
 * UpdateCard — shows current version and provides a trigger to update the pod software.
 * `compact` is the Status summary; the full card (Settings → Updates) adds the
 * build details and the main | dev channel picker.
 *
 * Wires into:
 * - system.getVersion → shows running version/branch
 * - system.triggerUpdate → kicks off sp-update (service will restart)
 * - system.internetStatus → checks if WAN is blocked
 * - system.setInternetAccess → temporarily unblocks WAN for updates
 *
 * After triggering an update the service restarts, so the UI shows a
 * "reconnecting" state and polls until the server comes back.
 *
 * If internet is blocked when the user initiates an update, the card
 * prompts to temporarily allow internet. After the update completes
 * (or fails), internet is re-blocked automatically.
 */
export function UpdateCard({ compact = false }: { compact?: boolean } = {}) {
  const utils = trpc.useUtils()
  const version = trpc.system.getVersion.useQuery({})
  const triggerUpdate = trpc.system.triggerUpdate.useMutation()
  const setInternetAccess = trpc.system.setInternetAccess.useMutation()

  const [updateState, setUpdateState] = useState<
    'idle' | 'confirming' | 'branch-picker' | 'internet-prompt' | 'unblocking' | 'updating' | 'reconnecting' | 'error'
  >('idle')
  const [selectedBranch, setSelectedBranch] = useState<string | undefined>(undefined)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  /** Tracks whether we temporarily unblocked internet and need to re-block */
  const didUnblockRef = useRef(false)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)
  /**
   * Version snapshot captured right before sp-update runs. Polling uses
   * this to distinguish "service is still the old build" from "service
   * restarted on the new build" — without it, the first poll racily
   * succeeds against the still-running old service and the UI re-blocks
   * WAN mid-download, killing the in-progress update.
   */
  const baselineVersionRef = useRef<{ commitHash: string, buildDate: string } | null>(null)
  /** Set to true once a poll fails — proves the service actually went down. */
  const sawDownRef = useRef(false)

  // Clean up poll timer on unmount and re-block internet if needed
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      // Fire-and-forget re-block if we unblocked internet and the user navigates away
      if (didUnblockRef.current) {
        didUnblockRef.current = false
        setInternetAccess.mutate({ blocked: true })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup-only ref, stable mutation object
  }, [])

  const versionData = version.data
  const isStandardBranch = versionData?.branch === 'main' || versionData?.branch === 'dev'

  /**
   * Re-block internet if we temporarily unblocked it.
   * Called after update completes, fails, or is cancelled.
   */
  const reblockIfNeeded = async () => {
    if (!didUnblockRef.current) return
    didUnblockRef.current = false
    try {
      await setInternetAccess.mutateAsync({ blocked: true })
      utils.system.internetStatus.invalidate()
    }
    catch {
      // Best effort — don't let re-block failure obscure the update result
    }
  }

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

  /** Unblock internet then proceed with the update */
  const handleAllowInternet = async () => {
    setUpdateState('unblocking')
    setErrorMessage(null)

    try {
      await setInternetAccess.mutateAsync({ blocked: false })
      didUnblockRef.current = true
      utils.system.internetStatus.invalidate()
      await startUpdate()
    }
    catch {
      setUpdateState('error')
      setErrorMessage('Failed to enable internet access. Try again or enable internet manually.')
    }
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
      // If the request fails immediately it might be because the service
      // already restarted (which is actually success)
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

        // Only call this "done" once we've proven the service actually
        // bounced. Otherwise we're talking to the old next-server still
        // serving the pre-update build — re-blocking WAN here kills
        // sp-update's still-pending tarball download.
        if (versionChanged || sawDownRef.current) {
          // Keep the React-Query cache in sync with what we just fetched
          // so other consumers re-render with the new version.
          utils.system.getVersion.setData({}, next)
          await reblockIfNeeded()
          setUpdateState('idle')
          return
        }

        // Old service is still up; sp-update hasn't reached `systemctl
        // stop` yet. Keep polling without unblocking guarantees.
        if (attempts < maxAttempts && !cancelledRef.current) {
          pollTimerRef.current = setTimeout(check, 2000)
        }
        else if (!cancelledRef.current) {
          await reblockIfNeeded()
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
          await reblockIfNeeded()
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

  const busy = updateState === 'unblocking' || updateState === 'updating' || updateState === 'reconnecting'
  const commit = versionData && versionData.commitHash !== 'unknown' ? versionData.commitHash.slice(0, 7) : '—'
  const branch = versionData && versionData.branch !== 'unknown' ? versionData.branch : '—'
  const built = versionData && versionData.buildDate !== 'unknown' ? formatBuildDate(versionData.buildDate) : '—'
  const channel: Channel | undefined = (selectedBranch ?? versionData?.branch) === 'main'
    ? 'main'
    : (selectedBranch ?? versionData?.branch) === 'dev' ? 'dev' : undefined

  const statusDot = updateState === 'error'
    ? <StatusDot tone="danger" label="Update failed" />
    : busy
      ? (
          <StatusDot
            tone="warn"
            label={updateState === 'unblocking' ? 'Enabling internet…' : updateState === 'updating' ? 'Updating…' : 'Reconnecting…'}
          />
        )
      : versionData ? <StatusDot tone="ok" label="Installed" /> : null

  /** Changing channel is an update to that branch — same confirm flow. */
  const handleChannel = (next: Channel) => {
    if (busy) return
    setErrorMessage(null)
    if (next === versionData?.branch) {
      setSelectedBranch(undefined)
      setUpdateState('idle')
      return
    }
    setSelectedBranch(next)
    setUpdateState('confirming')
  }

  const prompts = (
    <>
      {errorMessage && <Alert tone="danger">{errorMessage}</Alert>}

      {/* Branch picker for non-standard branches */}
      {updateState === 'branch-picker' && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[13px] text-warn">
            {`Current branch (${versionData?.branch}) is not a release channel. Pick a channel to update to:`}
          </p>
          <div className="flex gap-2.5">
            <Button onClick={() => handleBranchSelected('main')}>main</Button>
            <Button onClick={() => handleBranchSelected('dev')}>dev</Button>
            <Button variant="ghost" onClick={handleCancel}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Confirmation prompt */}
      {updateState === 'confirming' && (
        <p className="text-[13px] text-warn">
          {selectedBranch
            ? `This will switch to ${selectedBranch}, rebuild, and restart the service. The pod will be briefly unavailable.`
            : 'This will download the latest code, rebuild, and restart the service. The pod will be briefly unavailable.'}
        </p>
      )}

      {/* Internet blocked prompt */}
      {updateState === 'internet-prompt' && (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-[13px] text-warn">
            <Globe size={14} className="shrink-0" />
            Internet is currently blocked. Temporarily allow internet to check for updates?
          </p>
          <p className="text-xs text-fg-2">
            Internet will be re-blocked automatically after the update completes.
          </p>
        </div>
      )}

      {/* Unblocking/updating/reconnecting state */}
      {busy && (
        <p className="text-[13px] text-fg-2">
          {updateState === 'unblocking'
            ? 'Enabling internet access…'
            : updateState === 'updating'
              ? 'Triggering update…'
              : 'Waiting for service to restart…'}
        </p>
      )}
    </>
  )

  const actions = (updateState === 'idle' || updateState === 'confirming' || updateState === 'error' || updateState === 'internet-prompt') && (
    <div className="flex flex-wrap gap-2.5">
      {updateState === 'internet-prompt'
        ? (
            <Button variant="primary" icon={Globe} onClick={handleAllowInternet}>
              Allow &amp; update
            </Button>
          )
        : (
            <Button
              variant={updateState === 'confirming' ? 'primary' : 'secondary'}
              icon={updateState === 'confirming' ? Download : RefreshCw}
              onClick={handleUpdate}
              disabled={version.isLoading}
            >
              {updateState === 'confirming'
                ? 'Confirm update'
                : updateState === 'error'
                  ? 'Retry update'
                  : compact ? 'Check now' : 'Check for updates'}
            </Button>
          )}
      {(updateState === 'confirming' || updateState === 'internet-prompt') && (
        <Button variant="ghost" onClick={handleCancel}>Cancel</Button>
      )}
    </div>
  )

  if (compact) {
    return (
      <Card>
        <CardHeader title="Software" icon={Download} right={statusDot} />
        {version.isLoading
          ? <Skeleton className="h-5 border-0" />
          : (
              <div className="truncate font-mono text-[13px]">
                {`${branch} @ ${commit} · built ${versionData && versionData.buildDate !== 'unknown' ? formatBuildDate(versionData.buildDate, true) : '—'}`}
              </div>
            )}
        {prompts}
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">
            {versionData && versionData.commitTitle !== 'unknown' ? versionData.commitTitle : ''}
          </span>
          {actions}
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader title="Software" right={statusDot} />
      {version.isLoading
        ? <Skeleton className="h-[92px] border-0" />
        : (
            <div className="grid grid-cols-2 gap-3">
              <KeyValue label="Branch" value={branch} />
              <KeyValue label="Commit" value={commit} />
              <KeyValue label="Built" value={built} />
              <KeyValue
                label="Title"
                value={versionData && versionData.commitTitle !== 'unknown' ? versionData.commitTitle : '—'}
                valueClassName="font-sans"
                size={13}
              />
            </div>
          )}
      <SettingRow label="Update channel">
        <SegmentedControl
          ariaLabel="Update channel"
          value={channel ?? ('' as Channel)}
          options={['main', 'dev'] as const}
          onChange={handleChannel}
        />
      </SettingRow>
      {prompts}
      {actions}
    </Card>
  )
}
