# Auth Route Group Setup - 2026-02-23

## Changes Made

### 1. Restructured API Routes

Moved tRPC routes into an `(auth)` route group to prepare for future authentication:

**Before:**
```
app/api/
└── trpc/
    ├── route.ts
    └── [trpc]/
        └── route.ts
```

**After:**
```
app/api/
└── (auth)/
    ├── README.md              ← New: Deployment context documentation
    └── trpc/
        ├── route.ts
        └── [trpc]/
            └── route.ts
```

### 2. Documentation Added

**Created `app/api/(auth)/README.md`**
- Explains local hardware deployment context
- Documents why authentication is not currently needed
- Provides migration path for when auth is required
- Lists trigger conditions for implementing auth
- Shows example implementations (middleware & tRPC context-based)

**Created `src/server/routers/README.md`**
- Complete tRPC API documentation
- Router inventory with query/mutation counts
- Type safety and error handling status
- Usage examples (server & client-side)
- Cross-references to authentication strategy

## Key Points

### URL Paths Unchanged
Route groups use parentheses `(auth)` which **don't affect URL structure**:
- Routes still accessible at `/api/trpc/*`
- No breaking changes to frontend client
- No configuration updates needed

### Why This Structure?

1. **Future-Ready:** Grouped all endpoints that will need auth
2. **Clear Intent:** Name signals these handle sensitive operations
3. **Easy Migration:** Add middleware at `(auth)` level when needed
4. **Best Practice:** Separates concerns even without current auth requirements

### Local Hardware Deployment

**No Authentication Required Because:**
- Runs on localhost only (no external network)
- Physical access control (device in user's home)
- Single-user, single-device deployment
- Health data never leaves device
- Direct USB/socket hardware communication

### When to Add Auth

Implement authentication if any of these change:
- Network/WiFi access enabled
- Cloud sync or remote features
- Mobile app from different devices
- Multi-user support (left/right side different users)
- Web UI accessible from other machines

## Migration Path

When the time comes, adding auth is simple:

**Option 1: Next.js Middleware**
```typescript
// app/api/(auth)/middleware.ts
export function middleware(request: NextRequest) {
  const token = request.headers.get('authorization')
  if (!isValidToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.next()
}
```

**Option 2: tRPC Protected Procedure**
```typescript
// src/server/trpc.ts
const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx: { ...ctx, user: ctx.user } })
})
```

## Testing

Verify routes still work:
```bash
# Start dev server
pnpm dev

# Test tRPC endpoint
curl http://localhost:3000/api/trpc/device.getStatus
```

Frontend tRPC client usage unchanged:
```typescript
const { data } = trpc.device.getStatus.useQuery({ side: 'left' })
```

## Related Documents

- [`app/api/(auth)/README.md`](../app/api/(auth)/README.md) - Auth strategy details
- [`src/server/routers/README.md`](../src/server/routers/README.md) - tRPC API docs
- [`docs/trpc-review-2026-02-23.md`](./trpc-review-2026-02-23.md) - Security review

---

**Summary:** Successfully prepared API structure for future authentication while maintaining current local-only deployment with zero breaking changes.
