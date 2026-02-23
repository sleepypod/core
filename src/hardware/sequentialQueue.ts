/**
 * Sequential execution queue for hardware commands.
 * Ensures commands are executed one at a time to prevent race conditions.
 */
export class SequentialQueue {
  private executing: Promise<unknown> = Promise.resolve()

  /**
   * Execute a function sequentially, waiting for previous operations to complete.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    return this.execInternal(fn)
  }

  private execInternal<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.executing = this.executing
        .then(() => fn())
        .then(resolve)
        .catch(reject)
    })
  }

  /**
   * Get current queue depth (for monitoring).
   * Note: This is approximate as promises may resolve between checks.
   */
  isPending(): boolean {
    return this.executing !== Promise.resolve()
  }
}
