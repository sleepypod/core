# Import Patterns and Path Aliases

This document defines the standard import patterns for the codebase.

## Path Aliases

### `@/*` - Root-relative imports

Configured in `tsconfig.json`:
```json
"paths": {
  "@/*": ["./*"]
}
```

Maps to project root, allowing absolute imports like:
```typescript
import { appRouter } from '@/src/server/routers/app'
import { HardwareClient } from '@/src/hardware/client'
import { TRPCProvider } from '@/src/providers/TRPCProvider'
```

**Use case:** Cross-module imports (importing from a different top-level directory)

## Import Rules

### ✅ DO: Use `@/` for cross-module imports

When importing from a different top-level module, always use `@/` aliases:

```typescript
// In src/components/Temperature.tsx
import { HardwareClient } from '@/src/hardware/client'  // ✅ Cross-module

// In app/[lang]/page.tsx
import { BottomNav } from '@/src/components/BottomNav/BottomNav'  // ✅ Cross-module
import { trpc } from '@/src/utils/trpc'  // ✅ Cross-module
```

### ✅ DO: Use `./` for same-directory imports

Always use relative imports for files in the same directory:

```typescript
// In src/hardware/tests/client.test.ts
import { setupMockServer } from './testUtils'  // ✅ Same directory
import { DEVICE_STATUS_POD4 } from './fixtures'  // ✅ Same directory
```

### ✅ ACCEPTABLE: Use `../` for parent directory in tests

For test files importing from their parent module, ONE level of `../` is acceptable:

```typescript
// In src/hardware/tests/client.test.ts
import { HardwareClient } from '../client'  // ✅ Parent module (one level up)
import { HardwareCommand } from '../types'  // ✅ Parent module (one level up)
```

**Why:** Test files naturally live in a nested `tests/` directory and need to import
from the module they're testing. This is a standard pattern and more reliable than
path aliases in test environments.

### ❌ DON'T: Use deep relative imports

NEVER use multiple levels of `../`:

```typescript
// ❌ NEVER do this
import { something } from '../../other/module'
import { another } from '../../../lib/utils'
```

**Instead:** Use `@/` aliases for any cross-directory imports:

```typescript
// ✅ Use @ aliases
import { something } from '@/src/other/module'
import { another } from '@/src/lib/utils'
```

### ❌ DON'T: Use `~/` imports

The `~/` alias is NOT configured in this project. NEVER use it:

```typescript
// ❌ NEVER do this
import { something } from '~/hardware/client'
```

## Import Pattern Decision Tree

```
┌─ Same directory?
│  └─ YES → Use ./relative
│
├─ Parent directory AND in tests/?
│  └─ YES → Use ../ (one level only)
│
├─ Different top-level module?
│  └─ YES → Use @/ alias
│
└─ Multiple directories up?
   └─ ALWAYS → Use @/ alias (never ../../)
```

## Examples by File Location

### Application Code (`app/`, `src/components/`, `src/lib/`)

```typescript
// app/[lang]/page.tsx
import { getI18nInstance } from '@/src/lib/i18n/appRouterI18n'  // ✅ Cross-module
import { Header } from '@/src/components/Header/Header'  // ✅ Cross-module

// src/components/Temperature/Temperature.tsx
import { trpc } from '@/src/utils/trpc'  // ✅ Cross-module
import { HardwareClient } from '@/src/hardware/client'  // ✅ Cross-module
import { TemperatureDisplay } from './TemperatureDisplay'  // ✅ Same directory
```

### Test Files

```typescript
// src/hardware/tests/client.test.ts
import { HardwareClient } from '../client'  // ✅ Parent module (one level)
import { HardwareCommand } from '../types'  // ✅ Parent module (one level)
import { setupMockServer } from './testUtils'  // ✅ Same directory
import { DEVICE_STATUS_POD4 } from './fixtures'  // ✅ Same directory

// tests/integration/hardware.integration.test.ts
import { HardwareCommand } from '@/src/hardware/types'  // ✅ Cross-module
import { setupMockServer } from '@/src/hardware/tests/testUtils'  // ✅ Cross-module
```

### Module Code (`src/hardware/`, `src/db/`, `src/server/`)

```typescript
// src/hardware/client.ts
import { connectToSocket } from './socketClient'  // ✅ Same directory
import { parseDeviceStatus } from './responseParser'  // ✅ Same directory
import { HardwareCommand } from './types'  // ✅ Same directory

// src/server/routers/app.ts
import { createTRPCRouter } from '../trpc'  // ✅ Parent module (one level)
import { db } from '@/src/db'  // ✅ Cross-module
import { HardwareClient } from '@/src/hardware/client'  // ✅ Cross-module
```

## Why These Rules?

1. **`@/` aliases provide stable imports** - Files can move within a module without breaking cross-module imports
2. **`./` is clearest for same-directory** - Makes it obvious the import is local
3. **`../` is acceptable for tests** - Standard pattern, works reliably in test environments
4. **No deep `../` prevents fragility** - Deep relative paths break easily when refactoring
5. **Consistency aids readability** - Team members know what to expect

## Tooling Support

- **TypeScript:** Path aliases configured in `tsconfig.json`
- **Next.js:** Uses `tsconfig` paths automatically
- **Vitest:** Uses `vite-tsconfig-paths` plugin for path resolution
- **ESLint:** Can enforce these patterns (future enhancement)

## Migration Guide

When refactoring existing code:

1. ✅ Keep same-directory imports as `./`
2. ✅ Keep one-level-up test imports as `../`
3. ✅ Convert all `../../` (2+ levels) to `@/` aliases
4. ✅ Convert all cross-module imports to `@/` aliases
5. ❌ Remove any `~/` imports (not supported)

## Common Mistakes

### ❌ Using relative paths for cross-module imports

```typescript
// ❌ BAD
import { db } from '../../db'
import { HardwareClient } from '../../hardware/client'
```

```typescript
// ✅ GOOD
import { db } from '@/src/db'
import { HardwareClient } from '@/src/hardware/client'
```

### ❌ Using @ for same-directory imports

```typescript
// ❌ BAD - Overly verbose
import { setupMockServer } from '@/src/hardware/tests/testUtils'
```

```typescript
// ✅ GOOD - Simple and clear
import { setupMockServer } from './testUtils'
```

### ❌ Using ~ alias

```typescript
// ❌ NEVER - Not configured
import { something } from '~/hardware/client'
```

```typescript
// ✅ GOOD
import { something } from '@/src/hardware/client'
```

## Enforcement

These patterns should be followed for all new code and enforced during code review.

**Future enhancement:** Configure ESLint rules to automatically check:
- No imports with `../../` or deeper
- No `~/` imports
- Consistent use of `@/` for cross-module imports
