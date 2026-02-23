# ADR: Drizzle ORM with SQLite

**Status**: Accepted
**Date**: 2026-02-23

## Context

We need an ORM and database solution for the sleepypod-core pod control system that prioritizes:
- Maintainability and type safety
- Minimal runtime overhead (embedded Linux environment)
- Direct TypeScript integration
- Efficient SQLite operations

## Decision

We will use **Drizzle ORM** with **SQLite** for database access.

## Rationale

### Drizzle ORM

#### Superior TypeScript Integration
- True TypeScript-first design with direct type inference from schema
- No code generation step - schema is the code
- Cleaner git diffs (no generated files)

```typescript
// Drizzle - types inferred directly
export const deviceSettings = sqliteTable('device_settings', {
  id: integer('id').primaryKey(),
  timezone: text('timezone').notNull(),
})

// Usage - full type safety
const settings = await db.select().from(deviceSettings)
// settings is typed automatically
```

#### Lightweight Runtime
- **30KB runtime** vs 10MB+ alternatives
- No query engine binary
- Critical for embedded systems with limited storage
- Faster cold starts

#### SQL-Like Query Builder
- Closer to raw SQL, easier to debug
- Better control over query optimization
- Transparent performance characteristics

```typescript
// Clear, SQL-like syntax
await db
  .select()
  .from(deviceState)
  .where(eq(deviceState.side, 'left'))
  .orderBy(desc(deviceState.lastUpdated))
  .limit(10)
```

#### No Build Dependencies
- No `generate` step required
- Simpler CI/CD pipelines
- Immediate feedback during development

### SQLite Database

#### Perfect for Embedded Systems
- File-based, no separate database server
- Single-node deployment model
- Minimal operational complexity
- Suitable for pod hardware constraints

#### WAL Mode for Concurrency
```typescript
sqlite.pragma('journal_mode = WAL')  // Write-Ahead Logging
sqlite.pragma('synchronous = NORMAL')
sqlite.pragma('cache_size = -64000')  // 64MB cache
```

Benefits:
- Concurrent reads during writes
- Better performance for time-series data
- Atomic transactions

#### Optimized Configuration
```typescript
sqlite.pragma('temp_store = MEMORY')     // Fast temp operations
sqlite.pragma('mmap_size = 30000000000') // Memory-mapped I/O
sqlite.pragma('page_size = 4096')        // Optimal page size
sqlite.pragma('foreign_keys = ON')       // Referential integrity
```

## Implementation

### Database Connection
```typescript
// src/db/index.ts
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

const sqlite = new Database(DB_PATH)

// Apply optimizations
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('synchronous = NORMAL')
sqlite.pragma('cache_size = -64000')

export const db = drizzle(sqlite, { schema })
```

### Schema Definition
```typescript
// src/db/schema.ts
export const deviceSettings = sqliteTable('device_settings', {
  id: integer('id').primaryKey().$defaultFn(() => 1),
  timezone: text('timezone').notNull().default('America/Los_Angeles'),
  temperatureUnit: text('temperature_unit', { enum: ['F', 'C'] })
    .notNull()
    .default('F'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})
```

### Migration System
- SQL-based migrations in `src/db/migrations/`
- Auto-run on server startup
- Version tracking
- Seeding for default data

### Query Examples
```typescript
// Insert with conflict handling
await db.insert(deviceState)
  .values({ side: 'left', temperature: 72 })
  .onConflictDoUpdate({
    target: deviceState.side,
    set: { temperature: 72, updatedAt: new Date() }
  })

// Type-safe queries
const settings = await db.select()
  .from(deviceSettings)
  .where(eq(deviceSettings.id, 1))
  .limit(1)
```

## Alternatives Considered

### Prisma
**Pros**: Mature, good tooling
**Cons**: 10MB+ binary, code generation overhead, too heavy for embedded
**Verdict**: Rejected

### Raw SQLite (better-sqlite3)
**Pros**: Lightweight, full control
**Cons**: No type safety, manual query building, higher maintenance
**Verdict**: Rejected

### TypeORM
**Pros**: Mature, feature-rich
**Cons**: Decorator-based (not ideal for modern TS), heavier than Drizzle
**Verdict**: Rejected

### Kysely
**Pros**: Excellent type safety, SQL-like
**Cons**: Less integrated SQLite tooling than Drizzle
**Verdict**: Close second, chose Drizzle for better schema management

## Consequences

### Positive
✅ **30KB runtime** - Minimal overhead
✅ **No code generation** - Simpler workflow
✅ **Direct TypeScript** - Better type inference
✅ **SQL transparency** - Easier optimization
✅ **Embedded-optimized** - Fast cold starts
✅ **WAL mode** - Concurrent reads

### Negative
⚠️ **Newer ecosystem** - Fewer third-party tools
⚠️ **Learning curve** - Team needs to learn Drizzle patterns

### Neutral
🔄 **Different patterns** - SQL-like vs ORM-like queries

## Success Metrics

- Database operations < 50ms (p95)
- SQLite file size < 100MB (after 30 days)
- Memory footprint < 50MB
- Zero query-related runtime errors (via TypeScript)

## References

- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [SQLite WAL Mode](https://www.sqlite.org/wal.html)
- [SQLite Pragma Optimization](https://www.sqlite.org/pragma.html)

---

**Authors**: @ng (decision), Claude (implementation)
**Last Updated**: 2026-02-23
