import { withSideLock } from '../sideLock'
import { PositionDecoder, positionPacket, stopPacket } from './protocol'
import { BaseError, baseConfigurationSchema, baseMoveSchema } from './types'
import type { BaseConfiguration, BaseMove, BaseStatus, BaseTransport } from './types'

const STALE_MS = 10_000
export class BaseController {
  private config: BaseConfiguration | null = null
  private state: BaseStatus['state'] = 'unconfigured'
  private error: string | null = null
  private position: BaseStatus['position'] = null
  private lastUpdate: number | null = null
  private lastTicks: number[] | null = null
  private changedAt: Record<'left' | 'right', number | null> = { left: null, right: null }
  private samples = 0
  private busy = false
  private stopping = false
  private generation = 0
  private connectionGeneration = 0
  private writes: Promise<void> = Promise.resolve()
  private startup: Promise<void> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 5000
  private closed = false

  constructor(
    private readonly transport: BaseTransport,
    private readonly loadConfig: () => Promise<unknown>,
    private readonly now = Date.now,
    private readonly delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  ) {}

  start(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.startup ??= this.initialize().finally(() => {
      this.startup = null
    })
    return this.startup
  }

  private async initialize(): Promise<void> {
    const connection = ++this.connectionGeneration
    this.state = 'connecting'
    this.error = null
    try {
      const raw = await this.loadConfig()
      if (this.closed || connection !== this.connectionGeneration) return
      this.config = baseConfigurationSchema.parse(raw)
    }
    catch {
      if (this.closed || connection !== this.connectionGeneration) return
      this.config = null
      this.state = 'unconfigured'
      this.error = 'No valid adjustable-base configuration. Complete the stock base setup, then reconnect.'
      return
    }
    const decoder = new PositionDecoder()
    this.lastUpdate = null
    this.lastTicks = null
    this.position = null
    this.changedAt = { left: null, right: null }
    this.samples = 0
    try {
      await this.transport.connect(this.config, (bytes) => {
        if (this.closed || connection !== this.connectionGeneration) return
        for (const data of decoder.push(bytes)) {
          for (const [side, offset] of [['left', 0], ['right', 2]] as const) {
            if (this.lastTicks && [offset, offset + 1].some(i => data.ticks[i] !== this.lastTicks?.[i])) this.changedAt[side] = this.now()
          }
          this.samples++
          this.lastTicks = data.ticks
          this.position = { left: data.left, right: data.right }
          this.lastUpdate = this.now()
        }
      }, error => this.disconnected(error, connection))
      if (this.closed || connection !== this.connectionGeneration) return
      this.state = 'connected'
      this.error = null
      this.retryDelay = 5000
    }
    catch (error) {
      this.disconnected(error instanceof Error ? error : new Error('Bluetooth connection failed'), connection)
    }
  }

  private disconnected(error: Error, connection = this.connectionGeneration): void {
    if (this.closed || connection !== this.connectionGeneration) return
    ++this.connectionGeneration
    ++this.generation
    this.transport.close()
    this.state = 'disconnected'
    this.error = error.message
    if (!this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null
        void this.start()
      }, this.retryDelay)
      this.retry.unref?.()
      this.retryDelay = Math.min(30_000, this.retryDelay * 2)
    }
  }

  status(): BaseStatus {
    const stale = this.state !== 'connected' || this.lastUpdate === null || (this.now() < this.lastUpdate || this.now() - this.lastUpdate > STALE_MS)
    const motion = (side: 'left' | 'right') => {
      const changed = this.changedAt[side]
      return stale || this.samples < 2 ? null : changed !== null && this.now() - changed < 3000
    }
    const movingBySide = { left: motion('left'), right: motion('right') }
    return {
      independentControl: false, movingBySide,
      state: this.state, splitBase: this.config?.SplitBase ?? null,
      position: this.position, lastUpdate: this.lastUpdate, stale,
      moving: stale || this.samples < 2 ? null : movingBySide.left || movingBySide.right,
      busy: this.busy || this.stopping, error: this.error,
    }
  }

  async reconnect(): Promise<void> {
    if (this.busy || this.stopping) throw new BaseError('busy', 'Stop movement before reconnecting')
    if (this.startup) return this.startup
    if (this.closed) throw new BaseError('unavailable', 'Base controller has shut down')
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    ++this.generation
    this.transport.close()
    await this.start()
  }

  private assertReady(requireTelemetry: boolean): void {
    if (this.closed || this.state !== 'connected' || (requireTelemetry && this.status().stale)) {
      throw new BaseError('unavailable', 'Base is disconnected or its position is unavailable')
    }
  }

  private send(packet: Uint8Array, generation?: number): Promise<void> {
    const write = this.writes.catch(() => {}).then(async () => {
      if (generation !== undefined && generation !== this.generation) throw new BaseError('cancelled', 'Base movement cancelled')
      this.assertReady(generation !== undefined)
      try {
        await this.transport.write(packet)
      }
      catch (error) {
        this.disconnected(error instanceof Error ? error : new Error('Bluetooth write failed'))
        throw new BaseError('unavailable', 'Bluetooth write failed; movement was not confirmed')
      }
    })
    this.writes = write.catch(() => {})
    return write
  }

  async setPosition(input: BaseMove, canMove: () => Promise<boolean> = async () => true): Promise<void> {
    const position = baseMoveSchema.parse(input)
    if (position.sides.length !== 2) throw new BaseError('unavailable', 'This base supports whole-bed movement only')
    this.assertReady(true)
    if (this.busy || this.stopping) throw new BaseError('busy', 'Another base command is in progress')
    this.busy = true
    const generation = ++this.generation
    try {
      await withSideLock('left', () => withSideLock('right', async () => {
        this.assertReady(true)
        if (!await canMove()) return
        await this.send(positionPacket('head', position.head, position.feedRate), generation)
        await this.delay(500)
        if (!await canMove()) return
        await this.send(positionPacket('feet', position.feet, position.feedRate), generation)
      }))
    }
    finally {
      this.busy = false
    }
  }

  async stop(): Promise<void> {
    ++this.generation // Cancel even if offline, including moves awaiting side locks.
    if (this.stopping) throw new BaseError('busy', 'Stop is already in progress')
    this.stopping = true
    try {
      await this.send(stopPacket())
    }
    finally {
      this.stopping = false
    }
  }

  shutdown(): void {
    this.closed = true
    ++this.generation
    ++this.connectionGeneration
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.transport.close()
    this.state = 'disconnected'
  }
}
