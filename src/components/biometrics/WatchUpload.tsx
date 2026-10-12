'use client'

import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { Button, Modal } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { WATCH_REQUEST_TIMEOUT_MS } from '@/src/utils/watchUploadLimits'

interface ImportResult { stages: number, vitals: number, rejectedStageBatches: number, matchedStages: number, matchedVitals: number }

export function WatchUpload({ side, name }: { side: 'left' | 'right', name: string }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [days, setDays] = useState('30')
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const utils = trpc.useUtils()
  const upload = async () => {
    if (!file || busy.current) return
    if (file.size > 512 * 1024 * 1024) {
      setError('Choose an export smaller than 512 MiB')
      return
    }
    busy.current = true
    setProgress(0)
    setResult(null)
    setError(null)
    try {
      const response = await new Promise<ImportResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `/api/biometrics/watch-upload?side=${side}&days=${days}`)
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        xhr.timeout = WATCH_REQUEST_TIMEOUT_MS
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100))
        }
        xhr.onload = () => {
          try {
            const body = JSON.parse(xhr.responseText)
            if (xhr.status >= 200 && xhr.status < 300) resolve(body)
            else reject(new Error(body.error ?? 'Upload failed'))
          }
          catch { reject(new Error('The pod returned an invalid response')) }
        }
        xhr.onerror = () => reject(new Error('Connection lost. Some samples may have imported; retrying this export is safe.'))
        xhr.ontimeout = () => reject(new Error('Import timed out. Some samples may have imported; retrying this export is safe.'))
        xhr.send(file)
      })
      setResult(response)
      await utils.biometrics.invalidate()
    }
    catch (error) { setError(error instanceof Error ? error.message : 'Upload failed') }
    finally {
      busy.current = false
      setProgress(null)
    }
  }
  return (
    <>
      <Button icon={Upload} size="sm" onClick={() => setOpen(true)}>Upload Apple Watch data</Button>
      <Modal open={open} onClose={() => { if (!busy.current) setOpen(false) }} title="Upload Apple Watch data" width={600}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-2">
            {'Import for '}
            <strong className="text-fg">{name}</strong>
            {' '}
            (
            {side}
            {' '}
            side). Use this sleeper’s Apple Health export.
          </p>
          <section className="space-y-2 text-sm text-fg-2" aria-label="What this imports">
            <h3 className="font-medium text-fg">What this does</h3>
            <p>Imports Apple Watch heart rate and sleep stages for the selected period. Watch heart rate appears alongside the pod’s readings in Vitals so you can compare them; sleep stages are saved as reference data.</p>
            <p>This is a one-time import. Upload a fresh export whenever you want to add recent data. Previously imported records are skipped, and the pod’s own readings are preserved.</p>
          </section>
          <section className="space-y-2 text-sm text-fg-2" aria-label="How to get your export">
            <h3 className="font-medium text-fg">How to get your data</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>On your iPhone, open Health → Summary and tap your profile picture or initials.</li>
              <li>Scroll down, tap Export All Health Data, and confirm the export.</li>
              <li>Save the export to Files, or AirDrop it to the computer you’re using.</li>
              <li>Select export.zip below (no need to unzip), choose a period, then select Upload and sync.</li>
            </ol>
            <a href="https://support.apple.com/guide/iphone/share-your-health-data-iph5ede58c3d/ios" target="_blank" rel="noreferrer" className="inline-block text-link underline">Apple’s export guide</a>
          </section>
          <p className="text-xs text-fg-2">The full export is sent to your pod, which imports only Watch heart rate and sleep stages and removes the uploaded file after processing. ZIP or extracted export.xml, up to 512 MiB.</p>
          <label className="flex flex-col gap-2 text-sm">
            Health export
            <input
              aria-label="Health export"
              type="file"
              accept=".zip,.xml"
              disabled={progress !== null}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null)
                setError(null)
                setResult(null)
              }}
              className="rounded border border-line p-2"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            Import period
            <select aria-label="Import period" value={days} disabled={progress !== null} onChange={event => setDays(event.target.value)} className="rounded border border-line bg-surface p-2">
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
          {progress !== null && <p role="status" className="text-sm">{progress < 100 ? `Uploading… ${progress}%` : 'Importing on the pod… Keep this window open.'}</p>}
          {result && (
            <div role="status" className="text-sm">
              <p>{`Imported ${result.vitals} new heart-rate samples and ${result.stages} new sleep-stage segments.`}</p>
              <p className="text-fg-2">{`Found ${result.matchedVitals} heart-rate samples and ${result.matchedStages} stages in this period. Previously imported records are skipped.`}</p>
              {result.rejectedStageBatches > 0 && <p className="text-warn">{`${result.rejectedStageBatches} stage batches conflicted with stored stages and were skipped. Heart-rate import completed.`}</p>}
            </div>
          )}
          {error && <p role="alert" className="text-sm text-warn">{error}</p>}
          <Button icon={Upload} disabled={!file || progress !== null} onClick={upload}>Upload and sync</Button>
        </div>
      </Modal>
    </>
  )
}
