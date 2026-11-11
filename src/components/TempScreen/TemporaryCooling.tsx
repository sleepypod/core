'use client'

import { useEffect, useRef, useState } from 'react'
import { Snowflake } from 'lucide-react'
import { Button } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import type { CoolingPage } from '@/src/temperature/cooling'
import type { ControlAction, ControlReceipt, ControlRequest } from '@/src/controls/contract'
import { trpc } from '@/src/utils/trpc'
import { formatSetpointF, type TempUnit } from '@/src/lib/tempUtils'
import { useNow } from './TonightCard'

interface CoolingProps { side: Side, name: string, timeZone?: string, unit?: TempUnit }

/** A side change retires the old preview and response; pending actions never move to another zone. */
export function TemporaryCooling(props: CoolingProps) {
  return <CoolingControl key={props.side} {...props} />
}

function receiptMatches(receipt: ControlReceipt, request: ControlRequest): boolean {
  return receipt.requestId === request.requestId && receipt.issuedAt === request.issuedAt
    && receipt.expiresAt === request.expiresAt && JSON.stringify(receipt.action) === JSON.stringify(request.action)
}

function CoolingControl({ side, name, timeZone, unit = 'F' }: CoolingProps) {
  const now = useNow(1000).getTime()
  const query = trpc.device.getCooling.useQuery({ side }, { retry: false, refetchInterval: 10_000, refetchOnWindowFocus: 'always' })
  const submit = trpc.controls.submit.useMutation({ retry: false })
  const utils = trpc.useUtils()
  const [preview, setPreview] = useState<CoolingPage['proposal']>(null)
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<ControlRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const page = !query.isError && query.data?.side === side && query.data.generatedAt <= now
    && now - query.data.generatedAt < 20_000
    ? query.data
    : undefined
  const lease = page?.lease
  const proposal = page?.state === 'ready' ? page.proposal : null
  const validPreview = preview && proposal && preview.scope === proposal.scope && preview.fromTargetF === proposal.fromTargetF
    && preview.targetF === proposal.targetF && preview.expiresAt - now >= 60_000
  const clock = (at: number) => {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(at)
    }
    catch { return 'Time unavailable' }
  }
  const receiptText = (receipt: ControlReceipt) => receipt.state === 'acknowledged'
    ? 'The Pod acknowledged the request. Check the reported temperature; cooling is not instant.'
    : receipt.state === 'unknown' || receipt.state === 'executing'
      ? 'The result is unconfirmed. Check this request and the current Pod state; it will not be sent again.'
      : 'No new hardware change was confirmed. Refresh the Pod state before choosing another action.'

  const acceptReceipt = (receipt: ControlReceipt, request: ControlRequest) => {
    if (!receiptMatches(receipt, request)) throw new Error('Unmatched control receipt')
    setNotice(receiptText(receipt))
    if (receipt.state !== 'unknown' && receipt.state !== 'executing') setPending(null)
  }
  const send = async (action: ControlAction) => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setNotice('')
    setPreview(null)
    const issuedAt = Date.now()
    const request = { requestId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + 30_000, action }
    setPending(request)
    try {
      const receipt = await submit.mutateAsync(request)
      if (mounted.current) acceptReceipt(receipt, request)
    }
    catch {
      if (mounted.current) setNotice('The response was lost or unavailable. Check the existing request; do not resend it.')
    }
    finally {
      sending.current = false
      if (mounted.current) {
        setBusy(false)
        void query.refetch()
        void utils.device.getStatus.invalidate()
      }
    }
  }
  const checkRequest = async () => {
    if (!pending || sending.current) return
    sending.current = true
    setBusy(true)
    try {
      const receipt = await utils.controls.get.fetch({ requestId: pending.requestId })
      if (mounted.current) acceptReceipt(receipt, pending)
    }
    catch {
      if (mounted.current) setNotice('The request receipt is unavailable. Refresh the current Pod state before any further action.')
    }
    finally {
      sending.current = false
      if (mounted.current) {
        setBusy(false)
        void query.refetch()
      }
    }
  }

  return (
    <section aria-label="Temporary cooling" className="mb-5 border-y border-line py-4 text-sm [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">A little cooler, for now</h2>
          <p className="mt-1 text-fg-2">{`${side === 'left' ? 'Left' : 'Right'} zone · ${name}. Only this zone changes, even when sides are linked.`}</p>
        </div>
        {!lease && <Button icon={Snowflake} className="min-h-11 whitespace-normal" disabled={!proposal || busy || !!pending} onClick={() => setPreview(proposal)}>I’m too hot</Button>}
      </div>
      <p className="mt-2 max-w-prose text-fg-2">{page?.reason ?? 'Temporary cooling is unavailable. Refresh your Pod connection to check the current state.'}</p>
      {lease && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p>{page.state === 'cooling' ? `Requested ${formatSetpointF(lease.targetF, unit)} · return due ${clock(lease.expiresAt)}` : 'Return not confirmed · inspect the current target.'}</p>
          <Button className="min-h-11 whitespace-normal" disabled={busy || pending?.action.kind === 'cooling.cancel'} onClick={() => { void send({ kind: 'cooling.cancel', side, coolingId: lease.id }) }}>Cancel temporary cooling</Button>
        </div>
      )}
      {preview && (
        <div className="mt-3 space-y-3" aria-label="Review temporary cooling">
          <p>{`Request ${formatSetpointF(preview.targetF, unit)} instead of ${formatSetpointF(preview.fromTargetF, unit)}, until no later than ${clock(preview.expiresAt)}. This records “too hot” as feedback and pauses personal adaptation. Your wake schedule is unchanged.`}</p>
          {!validPreview && <p role="status">The proposal changed or expired. Refresh and review it again.</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              className="min-h-11 whitespace-normal"
              disabled={!validPreview || busy || !!pending}
              onClick={() => {
                if (validPreview) void send({ kind: 'cooling.start', side, coolingId: crypto.randomUUID(), expectedScope: preview.scope, expectedTargetF: preview.fromTargetF, expectedExpiresAt: preview.expiresAt })
              }}
            >
              Start temporary cooling
            </Button>
            <Button className="min-h-11" onClick={() => setPreview(null)}>Not now</Button>
          </div>
        </div>
      )}
      {notice && <p className="mt-3 text-fg-2" role="status">{notice}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {pending && <Button className="min-h-11 whitespace-normal" disabled={busy} onClick={() => { void checkRequest() }}>Check last request</Button>}
        <Button
          variant="ghost"
          className="min-h-11 whitespace-normal"
          disabled={busy || query.isFetching}
          onClick={() => {
            setPreview(null)
            void query.refetch()
          }}
        >
          Refresh cooling state
        </Button>
      </div>
    </section>
  )
}
