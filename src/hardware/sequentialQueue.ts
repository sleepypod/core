/**
 * Sequential execution queue for hardware commands.
 * Ensures commands are executed one at a time to prevent race conditions.
 */
export class SequentialQueue {
  private executing: Promise<unknown> = Promise.resolve()
  private pendingCount = 0

  /**
   * Execute a function sequentially, waiting for previous operations to complete.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    return this.execInternal(fn)
  }

  private execInternal<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingCount++
    return new Promise<T>((resolve, reject) => {
      this.executing = this.executing
        .then(() => fn())
        .then((result) => {
          this.pendingCount--
          resolve(result)
        })
        .catch((error) => {
          this.pendingCount--
          reject(error)
        })
    })
  }

  /**
   * Checks if any operations are currently pending in the queue.
   *
   * @returns true if operations are queued or executing, false if idle
   */
  isPending(): boolean {
    return this.pendingCount > 0
  }
}
