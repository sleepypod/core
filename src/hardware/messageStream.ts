import type { Readable } from 'stream'
import split from 'binary-split'

/**
 * Message stream parser for Unix socket communication.
 * Splits incoming data by delimiter and provides async message reading.
 */
export class MessageStream {
  private readonly messageQueue: Buffer[] = []
  private readonly delimiter: Buffer
  private pendingRead: ((value: Buffer) => void) | null = null
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
        const resolve = this.pendingRead
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
        const error = new Error('Stream ended while waiting for message')
        this.pendingRead = null
        throw error
      }
    })

    splitter.on('error', (error: Error) => {
      this.streamError = error
      if (this.pendingRead) {
        this.pendingRead = null
      }
      throw error
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
      this.pendingRead = resolve

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRead) {
          this.pendingRead = null
          reject(new Error('Message read timeout after 30 seconds'))
        }
      }, 30000)
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
   * Clean up resources.
   */
  destroy() {
    this.stream.unpipe()
    this.messageQueue.length = 0
    this.pendingRead = null
  }
}
