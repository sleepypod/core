'use client'

import { useEffect, useState } from 'react'

/** Measurement age, so a cached reading never silently looks current. */
export function SensorAge({ timestamp }: { timestamp?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (timestamp === undefined) return null
  const seconds = Math.max(0, Math.floor(now / 1000 - timestamp))
  return (
    <span className="font-mono text-[10px] font-normal tracking-normal text-fg-3 normal-case">
      {seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`}
    </span>
  )
}
