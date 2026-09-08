# Lark login for Unleash (via lark-auth-backoffice)

This fork adds a `customAuthHandler` that signs Unleash users in through the
in-house **lark-auth-backoffice V2** service. lark-auth is only the identity
source; roles stay inside Unleash.

```
Browser ── GET /auth/lark/login ──► Unleash ── 302 ──► {LARK_AUTH_FRONTEND_URL}/larkWeb/login?m=<module>&r=<callback>
                                                         │  Lark OAuth + TOTP handled by lark-auth
Browser ◄── 302 /auth/lark/callback?s=200&t=<jwt>&m=… ──┘
Unleash ── POST {LARK_AUTH_BACKEND_URL}/session/validateSession (Bearer <jwt>) ──► lark-auth → { email, name }
Unleash ── userService.loginUserSSO({ email, name, autoCreate: true, rootRole }) → session cookie → 302 /
```

Files:

| File | Purpose |
|------|---------|
| `src/lib/middleware/lark-authentication.ts` | handler: login redirect, callback, `/api` authorization |
| `src/lib/middleware/lark-authentication.test.ts` | unit tests (supertest + fake `userService`) |
| `src/server.ts` / `src/server-dev.ts` | both opt in automatically when `LARK_AUTH_MODULE_CODE` is set |

Contract source: Lark docs 「权限对接文档 D1.0.1」 and 「权限-SDK 技术对接文档」; the flow mirrors
FPMS-CCMS `src/api/larkAuth/client.ts` (hosted-login redirect + REST `validateSession`, no SDK).
Test environment: `https://lark-auth-web-v2.igo8.me` / `https://lark-auth-server-v2.igo8.me`.
The callback token may arrive as `t` or `token`; both are accepted.

## Configuration

| Env var | Required | Meaning |
|---------|----------|---------|
| `LARK_AUTH_FRONTEND_URL` | yes | lark-auth web, e.g. `https://lark-auth.example.com` |
| `LARK_AUTH_BACKEND_URL` | yes | lark-auth API, used for `POST /session/validateSession` (same call FPMS-CCMS makes) |
| `LARK_AUTH_MODULE_CODE` | yes | module code registered for Unleash in lark-auth (e.g. `UNLEASH`) |
| `UNLEASH_URL` | yes | public URL of this Unleash; the callback is `${UNLEASH_URL}/auth/lark/callback` |
| `LARK_AUTH_DEFAULT_ROLE` | no | root role for first-time users: `Viewer` (default), `Editor` or `Admin` |
| `MAX_PARALLEL_SESSIONS` | no | OSS default is 5 per user; raise it for shared accounts |

Both entry points load `./.env` via `dotenv/config` (values already present in the
process environment win, so K8s / Vault config is never overridden). For local work:

```bash
cp .env.example .env      # .env is git-ignored; edit as needed
pnpm run dev              # dev server, Lark login on
pnpm build && pnpm start  # production entry, same env vars
```

## lark-auth side

1. Create a `modules` row with `code = <LARK_AUTH_MODULE_CODE>` (RBAC → Modules). Only users
   granted access to that module can pass `/larkWeb/login`; everyone else gets `s=403&error=no_access`.
2. No permissions or functions need to be defined on the module. Unleash ignores lark-auth RBAC.

## Behaviour

- First login creates the Unleash user (matched by lowercase email) with `LARK_AUTH_DEFAULT_ROLE`.
  Promote users in **Admin → Users** inside Unleash; that is the only place roles live.
- The login page keeps the username/password form (for the built-in `admin` account) and shows a
  **Sign in with Lark** button underneath.
- Accounts whose Lark profile has no email (lark-auth falls back to `<open_id>@lark.local`) are
  rejected with an explanatory message instead of creating an unidentifiable user.
- A callback whose `m` does not match `LARK_AUTH_MODULE_CODE` is rejected.
- SDK / Edge traffic is unaffected: `/api/client` and `/api/frontend` keep using API tokens.
- Unleash's own session (`express-session` in Postgres, `SESSION_TTL_HOURS`, default 48h) governs
  how long a login lasts; lark-auth's 1h JWT is only used once, during the callback.

## Multiple projects and environments (`UNLEASH_MULTI_PROJECT=true`)

OSS locks the UI to the `default` project and the `default` / `development` /
`production` environments. Setting `UNLEASH_MULTI_PROJECT=true` runs the server in
the same shape as the hosted "Pro" plan (`src/lib/util/multi-project-from-env.ts`):

- backend `isOss` becomes false → the SQL / RBAC single-project filters are lifted;
- frontend `isOss()` becomes false → **New project**, environment management,
  project settings and project access pages are unlocked;
- `isEnterprise` stays false → change requests, private projects, SSO pages etc.
  remain disabled and never call enterprise-only stores.

Upstream OSS ships the project / environment *services* but mounts the write
routes only from the enterprise package, and its `GET /api/admin/projects`
hard-codes the `default` project. `src/lib/features/multi-project/` adds those
routes (`GET/POST/PUT/DELETE /api/admin/projects*`, `POST/PUT/DELETE
/api/admin/environments*`) and is mounted only in this mode.

Known limits: root roles only (Admin / Editor / Viewer — every Editor can edit
every project), no change requests, some Pro-only pages (network traffic,
Enterprise Edge, insights) call endpoints that OSS does not have and show empty
or 404 states. Unleash is AGPL-3.0: keep the fork's source available to users.
