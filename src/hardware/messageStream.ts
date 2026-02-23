import type { Readable } from 'stream'
import split from 'binary-split'

/**
 * Message stream parser for Unix socket communication.
 * Splits incoming data by delimiter and provides async message reading.
 */
interface PendingRead {
  resolve: (value: Buffer) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class MessageStream {
  private readonly messageQueue: Buffer[] = []
  private readonly delimiter: Buffer
  private pendingRead: PendingRead | null = null
  private streamEnded = false
  private streamError: Error | null = null

  constructor(
    private readonly stream: Readable,
    delimiter = '\n\n'
  ) {
    this.delimiter = Buffer.from(delimiter)
    this.setupStream()
  }

  private setupStream() {
    const splitter = split(this.delimiter)

    this.stream.pipe(splitter)

    splitter.on('data', (chunk: Buffer) => {
      if (this.pendingRead) {
        const { resolve, timer } = this.pendingRead
        clearTimeout(timer)
        this.pendingRead = null
        resolve(chunk)
      }
      else {
        this.messageQueue.push(chunk)
      }
    })

    splitter.on('end', () => {
      this.streamEnded = true
      if (this.pendingRead) {
        const { reject, timer } = this.pendingRead
        clearTimeout(timer)
        this.pendingRead = null
        reject(new Error('Stream ended while waiting for message'))
      }
    })

    splitter.on('error', (error: Error) => {
      this.streamError = error
      if (this.pendingRead) {
        const { reject, timer } = this.pendingRead
        clearTimeout(timer)
        this.pendingRead = null
        reject(error)
      }
    })
  }

  /**
   * Read the next message from the stream.
   * Waits if no messages are currently buffered.
   */
  async readMessage(): Promise<Buffer> {
    // Return buffered message if available
    if (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()
      if (!message) {
        throw new Error('Unexpected empty message queue')
      }
      return message
    }

    // Check for stream errors
    if (this.streamError) {
      throw this.streamError
    }

    // Check if stream ended
    if (this.streamEnded) {
      throw new Error('Cannot read from ended stream')
    }

    // Wait for next message
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRead) {
          this.pendingRead = null
          reject(new Error('Message read timeout after 30 seconds'))
        }
      }, 30000)

      this.pendingRead = { resolve, reject, timer }
    })
  }

  /**
   * Get the number of buffered messages.
   */
  get queueSize(): number {
    return this.messageQueue.length
  }

  /**
   * Check if stream has ended.
   */
  get hasEnded(): boolean {
    return this.streamEnded
  }

  /**
   * Cleans up resources and rejects any pending read promises.
   *
   * If a read operation is in progress, it will be rejected with an error
   * to prevent callers from hanging indefinitely.
   */
  destroy() {
    // Reject any pending read operation before cleanup
    if (this.pendingRead) {
      const { reject, timer } = this.pendingRead
      clearTimeout(timer)
      this.pendingRead = null
      reject(new Error('Stream destroyed'))
    }

    this.stream.unpipe()
    this.messageQueue.length = 0
  }
}
