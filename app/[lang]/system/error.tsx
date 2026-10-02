'use client'

import { Button, Card } from '@/src/components/ds'

export default function SystemError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="max-w-sm items-center text-center">
        <p className="text-[15px] font-medium text-danger">System crashed</p>
        <p className="text-[13px] text-fg-2">
          Something went wrong loading sensor data.
          {error.digest && <span className="ml-1 font-mono text-fg-3">{`(${error.digest})`}</span>}
        </p>
        <Button onClick={reset}>Retry</Button>
      </Card>
    </div>
  )
}
