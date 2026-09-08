/** Decoded firmware evidence, captured before gesture recognition or action dispatch. */
export function isRemoteEvidence(frame: Record<string, unknown>): boolean {
  return frame.type === 'buttonEvent' || frame.type === 'remoteReset'
    || (frame.type === 'log' && typeof frame.msg === 'string' && /\[(?:tca8418[^\]]*|i2c3)\]/.test(frame.msg))
}

/** Keep bounded NDJSON evidence in the browser; preserve the beginning and report omissions. */
export class RemoteRecording {
  private lines: string[] = []
  private bytes = 0
  dropped = 0
  constructor(private maxRecords = 2000, private maxBytes = 1024 * 1024) {}

  get count() { return this.lines.length }

  append(record: unknown) {
    const line = JSON.stringify(record)
    const size = new TextEncoder().encode(line).length + 1
    if (this.lines.length >= this.maxRecords || this.bytes + size > this.maxBytes) {
      this.dropped++
      return
    }
    this.lines.push(line)
    this.bytes += size
  }

  export(metadata: Record<string, unknown>) {
    return [JSON.stringify({ type: 'capture_metadata', schemaVersion: 1, ...metadata }), ...this.lines,
      JSON.stringify({ type: 'capture_summary', retained: this.count, omitted: this.dropped })].join('\n') + '\n'
  }
}
