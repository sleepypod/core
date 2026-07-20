import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeSqlite {
  path: string
  pragma: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  connections: [] as FakeSqlite[],
  database: vi.fn(),
  drizzle: vi.fn(),
}))

const originalDatabaseUrl = process.env.DATABASE_URL
const originalBiometricsDatabaseUrl = process.env.BIOMETRICS_DATABASE_URL

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

vi.mock('better-sqlite3', () => ({
  default: mocks.database,
}))

vi.mock('drizzle-orm/better-sqlite3', () => ({
  drizzle: mocks.drizzle,
}))

function connectionFor(path: string): FakeSqlite {
  const connection = mocks.connections.find(candidate => candidate.path === path)
  expect(connection, `SQLite connection for ${path}`).toBeDefined()
  return connection as FakeSqlite
}

describe('database connection modules', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.connections.length = 0
    mocks.database.mockReset().mockImplementation(function (path: string) {
      const connection: FakeSqlite = {
        path,
        pragma: vi.fn(),
        close: vi.fn(),
      }
      mocks.connections.push(connection)
      return connection
    })
    mocks.drizzle.mockReset().mockImplementation((sqlite, options) => ({ sqlite, options }))
    delete process.env.DATABASE_URL
    delete process.env.BIOMETRICS_DATABASE_URL
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreEnv('DATABASE_URL', originalDatabaseUrl)
    restoreEnv('BIOMETRICS_DATABASE_URL', originalBiometricsDatabaseUrl)
  })

  it('opens the main database at its default path with every required pragma', async () => {
    const mod = await import('../index')
    const connection = connectionFor('./sleepypod.dev.db')

    expect(mod.sqlite).toBe(connection)
    expect(connection.pragma.mock.calls.map(([pragma]) => pragma)).toEqual([
      'journal_mode = WAL',
      'busy_timeout = 5000',
      'synchronous = NORMAL',
      'cache_size = -64000',
      'temp_store = MEMORY',
      'mmap_size = 268435456',
      'foreign_keys = ON',
    ])

    const schema = await import('../schema')
    expect(mocks.drizzle).toHaveBeenCalledWith(connection, { schema })
    expect(mod.db).toEqual({ sqlite: connection, options: { schema } })
  })

  it('strips the file: prefix from the configured main database URL', async () => {
    process.env.DATABASE_URL = 'file:/tmp/configured-main.db'

    await import('../index')

    expect(mocks.database).toHaveBeenCalledWith('/tmp/configured-main.db')
  })

  it('uses the main default for an empty DATABASE_URL', async () => {
    process.env.DATABASE_URL = ''

    await import('../index')

    expect(mocks.database).toHaveBeenCalledWith('./sleepypod.dev.db')
  })

  it('closes the main connection and emits the shutdown message', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = await import('../index')
    const connection = connectionFor('./sleepypod.dev.db')

    mod.closeDatabase()

    expect(log).toHaveBeenCalledWith('Closing main database connection...')
    expect(connection.close).toHaveBeenCalledTimes(1)
  })

  it('opens the biometrics database at its default path with every required pragma', async () => {
    const mod = await import('../biometrics')
    const connection = connectionFor('./biometrics.dev.db')

    expect(connection.pragma.mock.calls.map(([pragma]) => pragma)).toEqual([
      'journal_mode = WAL',
      'busy_timeout = 5000',
      'synchronous = NORMAL',
      'cache_size = -32000',
      'temp_store = MEMORY',
      'mmap_size = 134217728',
    ])

    const schema = await import('../biometrics-schema')
    expect(mocks.drizzle).toHaveBeenCalledWith(connection, { schema })
    expect(mod.biometricsDb).toEqual({ sqlite: connection, options: { schema } })
  })

  it('strips the file: prefix from the configured biometrics database URL', async () => {
    process.env.BIOMETRICS_DATABASE_URL = 'file:/tmp/configured-biometrics.db'

    await import('../biometrics')

    expect(mocks.database).toHaveBeenCalledWith('/tmp/configured-biometrics.db')
  })

  it('preserves an explicitly empty biometrics database URL', async () => {
    process.env.BIOMETRICS_DATABASE_URL = ''

    await import('../biometrics')

    expect(mocks.database).toHaveBeenCalledWith('')
  })

  it('closes the biometrics connection and emits the shutdown message', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod = await import('../biometrics')
    const connection = connectionFor('./biometrics.dev.db')

    mod.closeBiometricsDatabase()

    expect(log).toHaveBeenCalledWith('Closing biometrics database connection...')
    expect(connection.close).toHaveBeenCalledTimes(1)
  })
})
