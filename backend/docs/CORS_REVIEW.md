# CORS Configuration Review

Scope: the Express API (`backend/src/config/cors.ts`, wired in `src/index.ts`). The NestJS auth service has a separate policy in `src/auth/cors.config.ts` driven by `ALLOWED_ORIGINS`.

## Allowed origins per environment

| Environment | Source | Allowed origins |
|-------------|--------|-----------------|
| development / test | `FRONTEND_URL` unset | `http://localhost:5173` |
| any | `FRONTEND_URL` set | exact value of `FRONTEND_URL` |
| production | `FRONTEND_URL` (required) | exact HTTPS frontend URL(s); no wildcard |

Requests with no `Origin` header (server-to-server, curl) are allowed. Matching is exact string equality (see `allowedOrigins.ts`).

## Behaviour verified by tests

`src/__tests__/cors.config.review.test.ts`:

- Preflight returns 204 with `Allow-Origin` (exact origin), `Allow-Credentials: true`, methods, headers and `Max-Age: 86400`.
- Credentialed requests never receive `Access-Control-Allow-Origin: *`.
- Unlisted origins receive no CORS headers.

## Findings and fixes

- Gap: `FRONTEND_URL=*` would have been accepted in production, and `isOriginAllowed` would then allow every origin together with `credentials: true`.
- Fix: `validateCorsConfig()` runs at startup (`src/index.ts`, before `helmet()`/`cors()`). It throws if production has a wildcard, if production has no `FRONTEND_URL`, or if any configured origin is not a valid http(s) URL.
