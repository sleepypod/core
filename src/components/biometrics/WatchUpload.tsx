'use client'

import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { Button, Modal } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'

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
        xhr.timeout = 11 * 60_000
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
      <Modal open={open} onClose={() => { if (!busy.current) setOpen(false) }} title="Upload Apple Watch data" width={520}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-2">
            {'Import for '}
            <strong className="text-fg">{name}</strong>
            {' '}
            (
            {side}
            {' '}
            side). In Apple Health, open your profile → Export All Health Data, then select export.zip or the extracted export.xml.
          </p>
          <p className="text-sm text-fg-2">Only Watch heart rate and sleep stages are imported. Existing records are preserved, and the uploaded file is removed after processing.</p>
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
