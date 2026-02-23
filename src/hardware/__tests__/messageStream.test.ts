import { describe, expect, test } from 'vitest'
import { MessageStream } from '../messageStream'
import { createMockReadable, sleep } from './testUtils'

describe('MessageStream', () => {
  test('reads buffered messages immediately', async () => {
    const stream = createMockReadable(['message1\n\n', 'message2\n\n'])
    const messageStream = new MessageStream(stream as any)

    // Wait for messages to be buffered
    await sleep(10)

    const msg1 = await messageStream.readMessage()
    const msg2 = await messageStream.readMessage()

    expect(msg1.toString()).toBe('message1')
    expect(msg2.toString()).toBe('message2')
  })

  test('waits for messages when buffer is empty', async () => {
    const messages: string[] = []
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
    const stream = createMockReadable(['msg1\n\n', 'msg2\n\n', 'msg3\n\n'])
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
    const stream = createMockReadable(['message\n\n'])
    const messageStream = new MessageStream(stream as any)

    await sleep(10)

    // This should not timeout even though we read immediately
    const msg = await messageStream.readMessage()
    expect(msg.toString()).toBe('message')
  })

  test('handles custom delimiter', async () => {
    const stream = createMockReadable(['msg1||', 'msg2||'])
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

  test('handles multiple simultaneous reads (should not happen in practice)', async () => {
    const stream: any = {
      pipe: (destination: any) => {
        setTimeout(() => destination.emit('data', Buffer.from('msg1')), 20)
        setTimeout(() => destination.emit('data', Buffer.from('msg2')), 40)
        return destination
      },
      unpipe: () => {},
      on: () => stream,
      once: () => stream,
      removeListener: () => stream,
    }

    const messageStream = new MessageStream(stream)

    // Start two reads at the same time (violates sequential contract but test anyway)
    const promise1 = messageStream.readMessage()
    const promise2 = messageStream.readMessage()

    const msg1 = await promise1
    const msg2 = await promise2

    // Both should resolve with different messages
    expect(msg1.toString()).toBe('msg1')
    expect(msg2.toString()).toBe('msg2')
  })
})
