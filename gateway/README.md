# API gateway

The gateway is the public-facing Express reverse proxy for Nova Launch. It adds security headers, an origin allowlist, per-route JWT authentication, Redis-backed sliding-window rate limiting, idempotency-key propagation, and proxying to the backend. Health endpoints are intentionally unauthenticated so container and monitoring checks can reach them.

## Prerequisites

- Node.js 20+ and npm.
- The backend service available at the configured `BACKEND_URL`.
- Redis 7+ available at the configured `REDIS_URL`.
- A local `.env` created from [`.env.example`](.env.example) for non-Compose development. Never commit `.env`, secret values, JWTs, credentials, or production payloads.
- Docker and Docker Compose for the containerized setup.

## Configuration

The gateway reads these environment variables. Values below are safe local defaults or descriptions only; set deployment-specific values outside version control.

| Variable | Default/behavior | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment. In `production`, `JWT_SECRET` is required. |
| `PORT` | `4000` | Canonical listening port. `GATEWAY_PORT` is accepted as a fallback. |
| `GATEWAY_PORT` | `4000` | Legacy listening-port variable, used only when `PORT` is absent. |
| `BACKEND_URL` | `http://localhost:3001` | Backend origin used by the reverse proxy. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection used for rate limiting. |
| `JWT_SECRET` | Development fallback only | Secret used to validate JWTs; provide a strong deployment-managed value in production. Do not place the value in documentation or source control. |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated browser origins allowed by CORS. |

`PORT` wins when both port variables are set. The gateway exposes `/health`, `/health/live`, and `/health/ready` without authentication. Requests matching configured API prefixes are proxied to `BACKEND_URL`; protected prefixes such as governance, webhooks, and admin require a valid JWT, while rate-limit tiers are applied per route.

## Local setup

From this directory:

```bash
cd gateway
cp .env.example .env
npm install
npm run dev
```

Start Redis separately and point `REDIS_URL` at it. For a production-style local process, build first and then start the compiled server:

```bash
npm run build
npm start
```

Expected health response:

```bash
curl -s http://localhost:4000/health
```

```json
{"status":"ok","service":"api-gateway","uptime":<number>}
```

A backend route should return the backend response through the proxy. For example, against an isolated local stack:

```bash
curl -i http://localhost:4000/api/tokens
```

Expect a backend response plus gateway rate-limit headers such as `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. The exact status and body depend on the backend data available.

## Docker Compose

The self-contained Compose file builds the gateway and starts Redis on the host port `6380`:

```bash
cd gateway
docker compose up -d --build
```

The gateway is then available at `http://localhost:4000`; Compose connects it to the `redis` service internally. Check service health and logs without printing environment values:

```bash
docker compose ps
docker compose logs gateway
curl -s http://localhost:4000/health
```

Stop the local services when finished:

```bash
docker compose down
```

To exercise the gateway in the complete Nova Launch stack, use the root overlay. It connects the gateway to the Compose backend and Redis services and repoints frontend API build arguments at port 4000:

```bash
docker compose -f docker-compose.yml -f docker-compose.gateway.yml up -d --build
curl -i http://localhost:4000/api/tokens
docker compose -f docker-compose.yml -f docker-compose.gateway.yml down
```

Expected startup behavior is a healthy Redis container followed by a healthy gateway container. A successful health request returns JSON with `status` set to `ok` and `service` set to `api-gateway`. If the gateway is unhealthy, first confirm that `BACKEND_URL`, Redis connectivity, allowed origins, and the production JWT configuration are supplied through the runtime environment rather than committed files.
