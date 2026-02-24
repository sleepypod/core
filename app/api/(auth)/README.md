# Authentication Route Group

## Current Status: No Authentication Required

This route group uses Next.js App Router's [route groups](https://nextjs.org/docs/app/building-your-application/routing/route-groups) pattern (parentheses notation) to organize all API endpoints that **will eventually require authentication**.

### Why No Auth Currently?

**Deployment Context: Local Hardware Only**

This application runs exclusively on local hardware (SleepyPod device) with **no external network exposure**:

- Server runs on localhost only
- No internet-facing endpoints
- No remote API access
- Single-user, single-device deployment
- No multi-tenant concerns
- Health/biometric data never leaves the device

**Security Posture:**
- Physical access control (device is in user's home)
- Network isolation (no external exposure)
- Direct hardware control (USB/local socket communication)
- No authentication needed for local-only deployment

### Benefits of (auth) Route Group Structure

Despite not implementing auth yet, this structure provides:

1. **Future-Ready Architecture**: All sensitive endpoints are grouped
2. **Clear Intent**: The `(auth)` name signals these routes handle sensitive operations
3. **Easy Migration Path**: When auth is needed, add middleware in one place
4. **Route Organization**: Parentheses folder doesn't affect URL paths
   - Routes stay at `/api/trpc/*` (not `/api/(auth)/trpc/*`)

### When to Add Authentication

Consider implementing auth if any of these change:

- [ ] Device becomes accessible over network/WiFi
- [ ] Cloud sync or remote monitoring features added
- [ ] Mobile app connects from different devices
- [ ] Multi-user support per device (e.g., left/right side different users)
- [ ] Web UI accessible from other machines on network
- [ ] Data export to external services

### How to Add Authentication Later

When the time comes, adding auth is straightforward:

**Option 1: Middleware at Route Group Level**
```typescript
// app/api/(auth)/middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Validate session, JWT, or API key
  const token = request.headers.get('authorization')

  if (!isValidToken(token)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/(auth)/:path*'
}
```

**Option 2: tRPC Context-Based Auth**
```typescript
// src/server/trpc.ts
import { TRPCError } from '@trpc/server'

const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx: { ...ctx, user: ctx.user } })
})

// Apply to routers
export const deviceRouter = router({
  setTemperature: protectedProcedure.input(...).mutation(...)
})
```

### Current API Endpoints in This Group

All tRPC procedures are in this route group:

**Device Control** (`/api/trpc`)
- Hardware temperature, power, alarm, priming operations
- Direct physical device control

**Biometrics** (`/api/trpc`)
- Sleep records, vitals, movement data
- Personal health information (PHI)

**Schedules** (`/api/trpc`)
- Temperature, power, and alarm schedules
- Recurring automation

**Settings** (`/api/trpc`)
- Device configuration, side settings, tap gestures

See [tRPC API Documentation](../../../src/server/routers/README.md) for full endpoint details.

### Related Documentation

- [tRPC Review Report](../../../docs/trpc-review-2026-02-23.md) - Comprehensive security analysis
- [Hardware Integration](../../../src/hardware/README.md) - Physical device communication
- [Database Schema](../../../src/db/README.md) - Data storage architecture

---

**Last Updated:** 2026-02-23
**Auth Status:** Not implemented (local hardware deployment)
**Requires Auth:** No (subject to change with network features)
