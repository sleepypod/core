# import patterns

## path aliases

`@/*` maps to project root (configured in tsconfig.json):

```typescript
import { HardwareClient } from '@/src/hardware/client'
import { db } from '@/src/db'
```

## rules

### ✅ use `@/` for cross-module imports

```typescript
// From src/components/ importing src/hardware/
import { HardwareClient } from '@/src/hardware/client'  // ✅
```

### ✅ use `./` for same-directory

```typescript
// In src/hardware/tests/
import { setupMockServer } from './testUtils'  // ✅
```

### ✅ use `../` for parent (tests only, one level)

```typescript
// In src/hardware/tests/
import { HardwareClient } from '../client'  // ✅ One level up
```

### ❌ never use deep relative paths

```typescript
import { something } from '../../other/module'  // ❌ Use @ instead
```

### ❌ never use `~/` imports

```typescript
import { something } from '~/hardware/client'  // ❌ Not configured
```

### ❌ never create barrel exports

No index.ts files that re-export:

```typescript
// ❌ NEVER src/hardware/index.ts
export { HardwareClient } from './client'
export { HardwareCommand } from './types'
```

**why:** Adds indirection, circular dependency risks, slows bundlers

**instead:** Import directly from source:

```typescript
import { HardwareClient } from '@/src/hardware/client'  // ✅
import { HardwareCommand } from '@/src/hardware/types'  // ✅
```

## decision tree

```
Same directory? → Use ./
Parent (tests)? → Use ../ (one level only)
Cross-module?   → Use @/
Multiple up?    → Use @/ (never ../../)
```
