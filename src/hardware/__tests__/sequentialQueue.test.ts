import { describe, expect, test } from 'vitest'
import { SequentialQueue } from '../sequentialQueue'
import { sleep } from './testUtils'

describe('SequentialQueue', () => {
  test('executes tasks sequentially', async () => {
    const queue = new SequentialQueue()
    const results: number[] = []

    // Start three tasks that take different times
    const promise1 = queue.exec(async () => {
      await sleep(30)
      results.push(1)
      return 1
    })

    const promise2 = queue.exec(async () => {
      await sleep(10)
      results.push(2)
      return 2
    })

    const promise3 = queue.exec(async () => {
      results.push(3)
      return 3
    })

    // All tasks should complete
    await Promise.all([promise1, promise2, promise3])

    // Results should be in order despite different execution times
    expect(results).toEqual([1, 2, 3])
  })

  test('returns task results', async () => {
    const queue = new SequentialQueue()

    const result1 = await queue.exec(async () => 'hello')
    const result2 = await queue.exec(async () => 42)
    const result3 = await queue.exec(async () => ({ key: 'value' }))

    expect(result1).toBe('hello')
    expect(result2).toBe(42)
    expect(result3).toEqual({ key: 'value' })
  })

  test('handles task errors without blocking queue', async () => {
    const queue = new SequentialQueue()
    const results: string[] = []

    const promise1 = queue.exec(async () => {
      results.push('task1')
      throw new Error('Task 1 failed')
    })

    const promise2 = queue.exec(async () => {
      results.push('task2')
      return 'success'
    })

    // First task should reject
    await expect(promise1).rejects.toThrow('Task 1 failed')

    // Second task should still execute
    await expect(promise2).resolves.toBe('success')

    // Both tasks should have executed
    expect(results).toEqual(['task1', 'task2'])
  })

  test('isPending returns true when tasks are queued', async () => {
    const queue = new SequentialQueue()

    expect(queue.isPending()).toBe(false)

    const promise = queue.exec(async () => {
      await sleep(50)
      return 'done'
    })

    expect(queue.isPending()).toBe(true)

    await promise

    expect(queue.isPending()).toBe(false)
  })

  test('isPending counts multiple queued tasks', async () => {
    const queue = new SequentialQueue()

    const promise1 = queue.exec(async () => {
      await sleep(20)
    })

    const promise2 = queue.exec(async () => {
      await sleep(20)
    })

    const promise3 = queue.exec(async () => {
      await sleep(20)
    })

    expect(queue.isPending()).toBe(true)

    await promise1
    expect(queue.isPending()).toBe(true)

    await promise2
    expect(queue.isPending()).toBe(true)

    await promise3
    expect(queue.isPending()).toBe(false)
  })

  test('handles synchronous tasks', async () => {
    const queue = new SequentialQueue()
    const results: number[] = []

    await queue.exec(async () => {
      results.push(1)
    })

    await queue.exec(async () => {
      results.push(2)
    })

    expect(results).toEqual([1, 2])
  })

  test('prevents race conditions', async () => {
    const queue = new SequentialQueue()
    let counter = 0

    // Start multiple tasks that read and increment counter
    const promises = Array.from({ length: 10 }, () =>
      queue.exec(async () => {
        const value = counter
        await sleep(1)
        counter = value + 1
      })
    )

    await Promise.all(promises)

    // Counter should be exactly 10 (no race conditions)
    expect(counter).toBe(10)
  })

  test('handles tasks that return undefined', async () => {
    const queue = new SequentialQueue()

    const result = await queue.exec(async () => {
      // Intentionally return nothing
    })

    expect(result).toBeUndefined()
  })

  test('handles tasks that throw immediately', async () => {
    const queue = new SequentialQueue()

    const promise = queue.exec(async () => {
      throw new Error('Immediate error')
    })

    await expect(promise).rejects.toThrow('Immediate error')
  })
})
