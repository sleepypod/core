/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test } from 'vitest'
import { PassThrough } from 'stream'
import { MessageStream } from '../messageStream'
import { createMockReadable, sleep } from './testUtils'

describe('MessageStream', () => {
  test('uses a double-newline delimiter by default across arbitrary chunks', async () => {
    const stream = new PassThrough()
    const messageStream = new MessageStream(stream)

    stream.write('first\n')
    stream.write('\nsecond\n\n')

    await expect(messageStream.readMessage()).resolves.toEqual(Buffer.from('first'))
    await expect(messageStream.readMessage()).resolves.toEqual(Buffer.from('second'))
    messageStream.destroy()
  })

  test('reads buffered messages immediately', async () => {
    const stream = createMockReadable(['message1', 'message2'])
    const messageStream = new MessageStream(stream as any)

    // Wait for messages to be buffered
    await sleep(10)

    const msg1 = await messageStream.readMessage()
    const msg2 = await messageStream.readMessage()

    expect(msg1.toString()).toBe('message1')
    expect(msg2.toString()).toBe('message2')
  })

  test('waits for messages when buffer is empty', async () => {
    const stream: any = {
      pipe: (destination: any) => {
        // Send first message immediately
        setTimeout(() => destination.emit('data', Buffer.from('msg1')), 0)
        // Send second message after delay
        setTimeout(() => destination.emit('data', Buffer.from('msg2')), 50)
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    const messageStream = new MessageStream(stream)

    const msg1 = await messageStream.readMessage()
    expect(msg1.toString()).toBe('msg1')

    // Should wait for second message
    const msg2 = await messageStream.readMessage()
    expect(msg2.toString()).toBe('msg2')
  })

  test('reports queue size correctly', async () => {
    const stream = createMockReadable(['msg1', 'msg2', 'msg3'])
    const messageStream = new MessageStream(stream as any)

    await sleep(10)

    expect(messageStream.queueSize).toBe(3)

    await messageStream.readMessage()
    expect(messageStream.queueSize).toBe(2)

    await messageStream.readMessage()
    expect(messageStream.queueSize).toBe(1)

    await messageStream.readMessage()
    expect(messageStream.queueSize).toBe(0)
  })

  test('handles stream end while waiting', async () => {
    const stream: any = {
      pipe: (destination: any) => {
        setTimeout(() => destination.emit('end'), 10)
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    const messageStream = new MessageStream(stream)

    await expect(messageStream.readMessage()).rejects.toThrow(
      'Stream ended while waiting for message'
    )
  })

  test('handles stream error', async () => {
    const stream: any = {
      pipe: (destination: any) => {
        setTimeout(() => destination.emit('error', new Error('Stream failed')), 10)
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    const messageStream = new MessageStream(stream)

    await expect(messageStream.readMessage()).rejects.toThrow('Stream failed')
  })

  test('rejects pending read on destroy', async () => {
    const stream: any = {
      pipe: (destination: any) => {
        // Never send any data
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    const messageStream = new MessageStream(stream)

    const readPromise = messageStream.readMessage()

    // Destroy while read is pending
    await sleep(10)
    messageStream.destroy()

    await expect(readPromise).rejects.toThrow('Stream destroyed')
  })

  test('clears timer on successful read', async () => {
    const stream = createMockReadable(['message'])
    const messageStream = new MessageStream(stream as any)

    await sleep(10)

    // This should not timeout even though we read immediately
    const msg = await messageStream.readMessage()
    expect(msg.toString()).toBe('message')
  })

  test('handles custom delimiter', async () => {
    // Note: Binary-split splits by delimiter, so messages should not include it
    const stream = createMockReadable(['msg1', 'msg2'])
    const messageStream = new MessageStream(stream as any, '||')

    await sleep(10)

    const msg1 = await messageStream.readMessage()
    const msg2 = await messageStream.readMessage()

    expect(msg1.toString()).toBe('msg1')
    expect(msg2.toString()).toBe('msg2')
  })

  test('hasEnded reflects stream state', async () => {
    const stream: any = {
      pipe: (destination: any) => {
        setTimeout(() => {
          destination.emit('data', Buffer.from('msg'))
          destination.emit('end')
        }, 10)
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    const messageStream = new MessageStream(stream)

    expect(messageStream.hasEnded).toBe(false)

    await sleep(20)

    expect(messageStream.hasEnded).toBe(true)
  })

  test('throws when reading from ended stream', async () => {
    const stream = createMockReadable(['msg\n\n'])
    const messageStream = new MessageStream(stream as any)

    await sleep(10)

    await messageStream.readMessage()

    // Stream should be ended now
    await sleep(10)

    await expect(messageStream.readMessage()).rejects.toThrow('Cannot read from ended stream')
  })

  test('throws when reading after error', async () => {
    const stream: any = {
      pipe: (destination: any) => {
        setTimeout(() => destination.emit('error', new Error('Test error')), 10)
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    const messageStream = new MessageStream(stream)

    // Wait for error
    await sleep(20)

    await expect(messageStream.readMessage()).rejects.toThrow('Test error')
  })

  test('discardBuffered drops queued messages and reports the count', async () => {
    const stream = createMockReadable(['stale1', 'stale2'])
    const messageStream = new MessageStream(stream as any)

    await sleep(10)
    expect(messageStream.queueSize).toBe(2)

    expect(messageStream.discardBuffered()).toBe(2)
    expect(messageStream.queueSize).toBe(0)
    expect(messageStream.discardBuffered()).toBe(0)
  })

  test('late response after read timeout is buffered, then discardable — not paired with next read', async () => {
    let dest: any
    const stream: any = {
      pipe: (destination: any) => {
        dest = destination
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    // Short read timeout so the test doesn't wait 30s
    const messageStream = new MessageStream(stream, '\n\n', 50)

    // Read times out — its response never arrived in time
    await expect(messageStream.readMessage()).rejects.toThrow('Message read timeout after 0.05 seconds')

    // The response arrives late: with no pending read it lands in the queue
    dest.emit('data', Buffer.from('stale-response'))
    expect(messageStream.queueSize).toBe(1)

    // The next command discards it instead of consuming it as its own
    expect(messageStream.discardBuffered()).toBe(1)

    const nextRead = messageStream.readMessage()
    dest.emit('data', Buffer.from('fresh-response'))
    expect((await nextRead).toString()).toBe('fresh-response')
  })

  test('handles pending read when data arrives', async () => {
    const stream: any = {
      pipe: (destination: any) => {
        // Emit data after a delay to test pending read
        setTimeout(() => destination.emit('data', Buffer.from('delayed-msg')), 20)
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    const messageStream = new MessageStream(stream)

    // This read will wait for data
    const msg = await messageStream.readMessage()

    expect(msg.toString()).toBe('delayed-msg')
  })
})
