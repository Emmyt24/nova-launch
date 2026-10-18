# Security Headers Middleware Review

Scope: `app.use(helmet())` in `backend/src/index.ts` (Express API).

## Verified settings (helmet defaults)

| Header | Value |
|--------|-------|
| Content-Security-Policy | `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'self'`, no `unsafe-eval` |
| Strict-Transport-Security | `max-age=15552000; includeSubDomains` |
| X-Content-Type-Options | `nosniff` |
| X-Frame-Options | `SAMEORIGIN` |
| Referrer-Policy | `no-referrer` |
| Cross-Origin-Opener-Policy / Resource-Policy | `same-origin` |
| X-Powered-By | removed |

## CSP and the API docs

The docs UI (`/api/v1/docs`, `swagger-ui-express`) serves its JS and CSS from the same origin, and its init script is a separate file, so `script-src 'self'` is sufficient. No CSP relaxation is needed and none was added. Styles use `'unsafe-inline'`, which is already part of helmet's default `style-src`.

## Exceptions

None. If the docs UI is ever switched to a CDN-hosted bundle, add the CDN host to `script-src`/`style-src` for the docs route only, not globally.

## Tests

`src/__tests__/securityHeaders.review.test.ts` asserts the headers above on an API route and on a swagger-ui docs route.

## Cross-origin note

`Cross-Origin-Resource-Policy: same-origin` applies to API responses; browser access from the frontend relies on CORS (see `CORS_REVIEW.md`), which is unaffected for `fetch` calls.
