# Tunnel Cookie Session Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace tunnel-mode `sessionStorage` / header / query-token browser auth with a session-cookie flow so first entry, deep-link refresh, API calls, WebSocket handshakes, and asset requests all continue to work after reloads.

**Architecture:** Keep `?token=` only as a one-time bootstrap parameter on the shared tunnel URL. When a browser document request enters through the Cloudflare tunnel with a valid query token, the Fastify auth hook should mint a host-only `HttpOnly` session cookie, redirect to the clean URL, and require that cookie for all subsequent HTTP and Socket.IO requests. Remove all frontend tunnel-token storage and all URL/header token injection so the browser relies on the cookie uniformly.

**Tech Stack:** Fastify, `@fastify/cookie`, Socket.IO, React 19, TypeScript, Vitest, pnpm

---

### Task 1: Add Server-Side Tunnel Cookie Primitives

**Files:**
- Create: `packages/server/src/utils/tunnel-cookie.ts`
- Create: `packages/server/src/utils/__tests__/tunnel-cookie.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Write the failing helper test**

Create `packages/server/src/utils/__tests__/tunnel-cookie.test.ts` with coverage for the shared cookie name and cookie-header parsing used by Socket.IO:

```ts
import { describe, expect, it } from 'vitest'
import {
  TUNNEL_SESSION_COOKIE_NAME,
  extractTunnelSessionTokenFromCookieHeader,
} from '../tunnel-cookie.js'

describe('tunnel-cookie', () => {
  it('extracts the tunnel session token from a cookie header', () => {
    expect(
      extractTunnelSessionTokenFromCookieHeader(
        `foo=1; ${TUNNEL_SESSION_COOKIE_NAME}=good-token; theme=dark`
      )
    ).toBe('good-token')
  })

  it('returns null when the tunnel session cookie is missing', () => {
    expect(extractTunnelSessionTokenFromCookieHeader('foo=1; theme=dark')).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/src/utils/__tests__/tunnel-cookie.test.ts`

Expected: FAIL because `packages/server/src/utils/tunnel-cookie.ts` does not exist yet.

**Step 3: Install and register cookie support**

Run: `pnpm add @fastify/cookie --filter @agent-tower/server`

Then plan to register the plugin near the other Fastify plugins in `packages/server/src/app.ts`:

```ts
import fastifyCookie from '@fastify/cookie'

await app.register(fastifyCookie)
```

**Step 4: Implement the shared cookie helper**

Create `packages/server/src/utils/tunnel-cookie.ts` with:

```ts
export const TUNNEL_SESSION_COOKIE_NAME = '__Host-agent-tower-tunnel'

export function extractTunnelSessionTokenFromCookieHeader(
  cookieHeader?: string,
): string | null {
  if (!cookieHeader) return null

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=')
    if (rawName === TUNNEL_SESSION_COOKIE_NAME) {
      return decodeURIComponent(rawValue.join('='))
    }
  }

  return null
}

export const TUNNEL_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run packages/server/src/utils/__tests__/tunnel-cookie.test.ts`

Expected: PASS

**Step 6: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/app.ts packages/server/src/utils/tunnel-cookie.ts packages/server/src/utils/__tests__/tunnel-cookie.test.ts
git commit -m "refactor: add tunnel session cookie primitives"
```

### Task 2: Move HTTP Tunnel Auth to Cookie + Clean Redirect

**Files:**
- Create: `packages/server/src/middleware/__tests__/tunnel-auth.test.ts`
- Modify: `packages/server/src/middleware/tunnel-auth.ts`

**Step 1: Write the failing HTTP auth test**

Create `packages/server/src/middleware/__tests__/tunnel-auth.test.ts` using a tiny Fastify app with `@fastify/cookie` registered and `tunnelAuthHook` attached. Cover these cases:

```ts
it('bootstraps a tunnel session from a valid document query token', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/settings/general?token=good-token&tab=advanced',
    headers: {
      'cf-ray': 'abc123',
      accept: 'text/html',
      'sec-fetch-dest': 'document',
    },
  })

  expect(response.statusCode).toBe(302)
  expect(response.headers.location).toBe('/settings/general?tab=advanced')
  expect(String(response.headers['set-cookie'])).toContain('__Host-agent-tower-tunnel=good-token')
})

it('allows tunnel API requests that already carry the tunnel session cookie', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/ping',
    headers: {
      'cf-ray': 'abc123',
      cookie: '__Host-agent-tower-tunnel=good-token',
    },
  })

  expect(response.statusCode).toBe(200)
})

it('rejects tunnel requests without a valid session cookie or bootstrap token', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/ping',
    headers: { 'cf-ray': 'abc123' },
  })

  expect(response.statusCode).toBe(401)
})
```

Mock `TunnelService.isRunning()` to `true` and `TunnelService.validateToken()` so only `good-token` is accepted.

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/src/middleware/__tests__/tunnel-auth.test.ts`

Expected: FAIL because the middleware still only reads `Authorization` / query token and does not set cookies or redirect.

**Step 3: Implement cookie-first HTTP auth**

Update `packages/server/src/middleware/tunnel-auth.ts` to:

- Read `request.cookies[TUNNEL_SESSION_COOKIE_NAME]` first.
- Continue to accept `?token=` as a bootstrap token.
- Detect a browser document navigation with:

```ts
const isDocumentRequest =
  request.method === 'GET'
  && (
    request.headers['sec-fetch-dest'] === 'document'
    || request.headers.accept?.includes('text/html')
  )
```

- When a valid bootstrap query token arrives on a document request:
  - `reply.setCookie(TUNNEL_SESSION_COOKIE_NAME, token, TUNNEL_SESSION_COOKIE_OPTIONS)`
  - remove only the `token` query parameter
  - `reply.redirect(302, cleanUrl)`
- When a valid bootstrap query token arrives on a non-document request:
  - set the cookie
  - allow the request to continue without redirect
- Remove `Authorization` as an accepted browser auth path.
- Keep the existing static-asset bypass for `/assets`, `/vite.svg`, `/favicon.ico`.

**Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/server/src/middleware/__tests__/tunnel-auth.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/server/src/middleware/tunnel-auth.ts packages/server/src/middleware/__tests__/tunnel-auth.test.ts
git commit -m "fix: bootstrap tunnel cookie sessions on document requests"
```

### Task 3: Switch Socket.IO Tunnel Auth to Cookie-Only

**Files:**
- Create: `packages/server/src/socket/middleware/__tests__/auth.test.ts`
- Modify: `packages/server/src/socket/middleware/auth.ts`

**Step 1: Write the failing socket auth test**

Create `packages/server/src/socket/middleware/__tests__/auth.test.ts` with minimal socket stubs:

```ts
it('accepts tunnel websocket connections with a valid tunnel session cookie', () => {
  const socket = makeSocket({
    headers: {
      'cf-ray': 'abc123',
      cookie: '__Host-agent-tower-tunnel=good-token',
    },
  })

  const next = vi.fn()
  authMiddleware(socket, next)

  expect(next).toHaveBeenCalledWith()
})

it('rejects tunnel websocket connections that only send auth.token', () => {
  const socket = makeSocket({
    headers: { 'cf-ray': 'abc123' },
    auth: { token: 'good-token' },
  })

  const next = vi.fn()
  authMiddleware(socket, next)

  expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/src/socket/middleware/__tests__/auth.test.ts`

Expected: FAIL because the middleware still depends on `socket.handshake.auth.token` / query token.

**Step 3: Implement cookie-based socket auth**

Update `packages/server/src/socket/middleware/auth.ts` to:

- Parse `socket.request.headers.cookie` with `extractTunnelSessionTokenFromCookieHeader(...)`
- Validate that cookie for tunnel requests
- Remove `socket.handshake.auth?.token` and `socket.handshake.query?.token` from the auth decision
- Use the cookie token only for optional `socket.userId` / `socket.username` labelling

Implementation target:

```ts
const cookieToken = extractTunnelSessionTokenFromCookieHeader(
  socket.request.headers.cookie
)

if (isTunnel && TunnelService.isRunning()) {
  if (!cookieToken || !TunnelService.validateToken(cookieToken)) {
    return next(new Error('Unauthorized: valid tunnel session cookie required'))
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/server/src/socket/middleware/__tests__/auth.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/server/src/socket/middleware/auth.ts packages/server/src/socket/middleware/__tests__/auth.test.ts
git commit -m "refactor: use tunnel session cookies for socket auth"
```

### Task 4: Remove Frontend Tunnel Token Storage and Injection

**Files:**
- Delete: `packages/web/src/lib/tunnel-token.ts`
- Create: `packages/web/src/lib/__tests__/api-client.test.ts`
- Create: `packages/web/src/lib/socket/__tests__/manager.test.ts`
- Modify: `packages/web/src/main.tsx`
- Modify: `packages/web/src/lib/api-client.ts`
- Modify: `packages/web/src/lib/socket/manager.ts`
- Modify: `packages/web/src/hooks/use-attachments.ts`
- Modify: `packages/web/src/components/task/TaskDetail.tsx`
- Modify: `packages/web/src/components/mobile/MobileTaskDetail.tsx`
- Modify: `packages/web/src/components/agent/LogStream.tsx`
- Modify: `packages/web/src/components/workspace/EditorView.tsx`
- Modify: `packages/web/src/components/ui/AttachmentPreview.tsx`

**Step 1: Write the failing client regression tests**

Create `packages/web/src/lib/__tests__/api-client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api-client'

describe('api-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    }))
  })

  it('does not attach a tunnel Authorization header', async () => {
    await apiClient.get('/projects')

    expect(fetch).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({
        headers: {},
      })
    )
  })
})
```

Create `packages/web/src/lib/socket/__tests__/manager.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { io } from 'socket.io-client'
import { socketManager } from '../manager'

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    onAny: vi.fn(),
  })),
}))

it('creates a socket connection without auth.token', () => {
  socketManager.disconnect()
  socketManager.connect()

  expect(io).toHaveBeenCalledWith(
    expect.any(String),
    expect.not.objectContaining({ auth: expect.anything() })
  )
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run \
  packages/web/src/lib/__tests__/api-client.test.ts \
  packages/web/src/lib/socket/__tests__/manager.test.ts
```

Expected: FAIL because the client still reads `tunnel-token.ts`, sets `Authorization`, and passes `auth.token` into Socket.IO.

**Step 3: Remove startup token bootstrapping**

Update `packages/web/src/main.tsx` to remove:

```ts
import { initTunnelToken } from './lib/tunnel-token'
initTunnelToken()
```

Delete `packages/web/src/lib/tunnel-token.ts`.

**Step 4: Remove all header/query token injection points**

Apply the following edits:

- `packages/web/src/lib/api-client.ts`
  - remove `getTunnelToken` / `isTunnelAccess`
  - stop adding `Authorization`
- `packages/web/src/lib/socket/manager.ts`
  - stop building `auth.token`
  - keep the rest of the socket configuration unchanged
- `packages/web/src/hooks/use-attachments.ts`
  - remove tunnel-specific `Authorization` upload header
- `packages/web/src/components/task/TaskDetail.tsx`
  - remove `withToken(...)`
  - return raw `/api/attachments/by-path?...` URLs
- `packages/web/src/components/mobile/MobileTaskDetail.tsx`
  - same cleanup as desktop
- `packages/web/src/components/agent/LogStream.tsx`
  - stop appending `?token=` to attachment URLs
- `packages/web/src/components/workspace/EditorView.tsx`
  - stop appending `token` to `/api/files/image?...`
- `packages/web/src/components/ui/AttachmentPreview.tsx`
  - stop appending `token` to attachment preview URLs

**Step 5: Run tests to verify they pass**

Run:

```bash
pnpm exec vitest run \
  packages/web/src/lib/__tests__/api-client.test.ts \
  packages/web/src/lib/socket/__tests__/manager.test.ts
```

Expected: PASS

**Step 6: Run a web build to catch stray imports**

Run: `pnpm --filter web build`

Expected: PASS with no remaining imports of `packages/web/src/lib/tunnel-token.ts`.

**Step 7: Commit**

```bash
git add packages/web/src/main.tsx packages/web/src/lib/api-client.ts packages/web/src/lib/socket/manager.ts packages/web/src/hooks/use-attachments.ts packages/web/src/components/task/TaskDetail.tsx packages/web/src/components/mobile/MobileTaskDetail.tsx packages/web/src/components/agent/LogStream.tsx packages/web/src/components/workspace/EditorView.tsx packages/web/src/components/ui/AttachmentPreview.tsx packages/web/src/lib/__tests__/api-client.test.ts packages/web/src/lib/socket/__tests__/manager.test.ts
git rm packages/web/src/lib/tunnel-token.ts
git commit -m "refactor: remove client-managed tunnel tokens"
```

### Task 5: Run Regression Checks Against the Full Tunnel Flow

**Files:**
- No new source files

**Step 1: Run the targeted automated suite**

Run:

```bash
pnpm exec vitest run \
  packages/server/src/utils/__tests__/tunnel-cookie.test.ts \
  packages/server/src/middleware/__tests__/tunnel-auth.test.ts \
  packages/server/src/socket/middleware/__tests__/auth.test.ts \
  packages/web/src/lib/__tests__/api-client.test.ts \
  packages/web/src/lib/socket/__tests__/manager.test.ts
```

Expected: PASS

**Step 2: Run the monorepo build**

Run: `pnpm build`

Expected: PASS

**Step 3: Perform a manual tunnel smoke test**

Run through this exact matrix:

1. Start the app locally and start the tunnel from the UI.
2. Copy the generated `shareableUrl` and open it in a fresh private/incognito browser window.
3. Confirm the first request returns `302` from `...?token=...` to the clean URL and includes:

```text
Set-Cookie: __Host-agent-tower-tunnel=<token>; Path=/; HttpOnly; Secure; SameSite=Lax
```

4. Refresh `/` and a deep route like `/settings/general`; both should render instead of returning `401`.
5. Open DevTools Network and confirm subsequent document, `/api/...`, and `socket.io` requests no longer carry `token=` in the URL.
6. Verify inline markdown attachments, attachment preview thumbnails, and workspace image preview still load.
7. Reload the page and confirm the socket reconnects successfully.
8. Stop the tunnel, open the old URL again, and confirm it is rejected.
9. Start a new tunnel, open the new URL, and confirm a fresh cookie session is created.

**Step 4: Commit**

```bash
git add .
git commit -m "fix: persist tunnel access across page reloads"
```

### Non-Goals

- Do not add a persistent cookie (`maxAge`, `expires`). This must remain a browser-session cookie.
- Do not try to clear the tunnel cookie from the local `localhost` stop endpoint; the cookie is scoped to the tunnel host and will become invalid automatically when the tunnel token rotates or the browser session ends.
- Do not broaden access by skipping auth for HTML documents. The fix is to unify auth on cookies, not to weaken the tunnel guard.
