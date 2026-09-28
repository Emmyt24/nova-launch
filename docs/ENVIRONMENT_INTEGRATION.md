# Environment Integration Guide

Single source of truth for all network and contract configuration across the
frontend, backend, and deployment scripts.

---

## Canonical Env File

After running `scripts/deploy-testnet.sh`, a file named `.env.testnet` (or
`.env.mainnet` for mainnet) is written at the repo root. It contains every
value that the frontend, backend, and scripts need:

```
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
FACTORY_CONTRACT_ID=<deployed-contract-id>

# Frontend equivalents
VITE_NETWORK=testnet
VITE_FACTORY_CONTRACT_ID=<deployed-contract-id>
```

All other env files are derived from this one.

---

## Variable Mapping

| Variable | Frontend (`VITE_*`) | Backend | Scripts |
|---|---|---|---|
| Network | `VITE_NETWORK` | `STELLAR_NETWORK` | `STELLAR_NETWORK` |
| Horizon URL | _(derived)_ | `STELLAR_HORIZON_URL` | `STELLAR_HORIZON_URL` |
| Soroban RPC URL | _(derived)_ | `STELLAR_SOROBAN_RPC_URL` | `STELLAR_SOROBAN_RPC_URL` |
| Network passphrase | _(derived)_ | `STELLAR_NETWORK_PASSPHRASE` _(derived if unset)_ | — |
| Factory contract ID | `VITE_FACTORY_CONTRACT_ID` | `FACTORY_CONTRACT_ID` | `FACTORY_CONTRACT_ID` |

"Derived" means the value is computed automatically from `STELLAR_NETWORK` /
`VITE_NETWORK` — you do not need to set it manually unless you want to
override the default.

---

## Validation Behaviour

### Frontend (`frontend/src/config/env.ts`)

- In **development/test**: missing `VITE_FACTORY_CONTRACT_ID` is allowed (logs
  a warning implicitly via empty string).
- In **production** (`import.meta.env.PROD === true`): missing
  `VITE_FACTORY_CONTRACT_ID` throws at module load time, preventing a broken
  build from being served.
- Invalid `VITE_NETWORK` value always throws.

### Backend (`backend/src/config/env.ts` + `backend/src/index.ts`)

- `validateEnv()` is called before the Express server starts.
- `DATABASE_URL` is always required.
- In **production**: `FACTORY_CONTRACT_ID` and a non-default `JWT_SECRET` are
  required; the process exits with a descriptive error if either is missing.
- `STELLAR_HORIZON_URL` and `STELLAR_SOROBAN_RPC_URL` default to the correct
  URLs for the chosen `STELLAR_NETWORK` if not explicitly set.

---

## Deployment Matrix

| Environment | Env file | Network | Notes |
|---|---|---|---|
| Local dev | `frontend/.env` + `backend/.env` | testnet | Copy from `.env.testnet` after deploy |
| Staging | CI secrets / `.env.testnet` | testnet | Set `FACTORY_CONTRACT_ID` in CI |
| Production | CI secrets / `.env.mainnet` | mainnet | All required vars must be set |

---

## Switching Networks

Change **one** variable (`STELLAR_NETWORK` / `VITE_NETWORK`) and all dependent
URLs update automatically:

```bash
# Testnet (default)
STELLAR_NETWORK=testnet

# Mainnet
STELLAR_NETWORK=mainnet
```

The Horizon URL, Soroban RPC URL, and network passphrase are derived from this
single value in both the frontend (`frontend/src/config/stellar.ts`) and the
backend (`backend/src/config/env.ts`).

---

## Required Variables Reference

### Frontend (`.env` in `frontend/`)

| Variable | Required in prod | Description |
|---|---|---|
| `VITE_NETWORK` | No (defaults to `testnet`) | `testnet` or `mainnet` |
| `VITE_FACTORY_CONTRACT_ID` | **Yes** | Deployed contract address |
| `VITE_IPFS_API_KEY` | No | Pinata API key for metadata uploads |
| `VITE_IPFS_API_SECRET` | No | Pinata API secret |

### Backend (`.env` in `backend/`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Always** | PostgreSQL connection string |
| `JWT_SECRET` | **Always in prod** | Must not be the default placeholder |
| `STELLAR_NETWORK` | No (defaults to `testnet`) | `testnet` or `mainnet` |
| `STELLAR_HORIZON_URL` | No (derived) | Override default Horizon URL |
| `STELLAR_SOROBAN_RPC_URL` | No (derived) | Override default Soroban RPC URL |
| `FACTORY_CONTRACT_ID` | **Yes in prod** | Deployed contract address |
| `PORT` | No (defaults to `3001`) | HTTP server port |
| `STELLAR_REQUEST_TIMEOUT` | No (default: `30000`) | Per-request RPC timeout in ms |
| `STELLAR_RETRY_MAX_ATTEMPTS` | No (default: `3`) | Max retry attempts for transient RPC errors |
| `STELLAR_RETRY_INITIAL_DELAY` | No (default: `1000`) | Initial backoff delay in ms before first retry |
| `STELLAR_RETRY_MAX_DELAY` | No (default: `10000`) | Max backoff delay cap in ms |
| `STELLAR_RETRY_BACKOFF_FACTOR` | No (default: `2`) | Exponential backoff multiplier between retries |
| `STELLAR_RATE_LIMIT_MAX` | No (default: `100`) | Max outbound RPC requests per window |
| `STELLAR_RATE_LIMIT_WINDOW_MS` | No (default: `60000`) | Rate-limit window in ms |
| `STELLAR_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | No (default: `5`) | Consecutive failures before circuit opens |
| `STELLAR_CIRCUIT_BREAKER_SUCCESS_THRESHOLD` | No (default: `2`) | Consecutive successes in half-open before closing |
| `STELLAR_CIRCUIT_BREAKER_TIMEOUT_MS` | No (default: `60000`) | Time circuit stays open before retrying in ms |

### ELK Stack (`docker-compose.elk.yml`)

| Variable | Required | Description |
|---|---|---|
| `ELASTICSEARCH_PASSWORD` | **Yes — change before deploying** | Password for the `elastic` superuser. The Docker Compose file defaults to `changeme` when this variable is unset. **Never use the default in any non-local environment.** Set this in your shell or `.env` before running `docker compose … -f docker-compose.elk.yml`. |

> **Security note:** `docker-compose.elk.yml` uses `${ELASTICSEARCH_PASSWORD:-changeme}` as a
> fallback.  A contributor who launches the ELK stack without explicitly setting this variable
> will silently run with the default `changeme` password for Elasticsearch, Logstash, and Kibana.
> Always set `ELASTICSEARCH_PASSWORD` in `.env` (see root `.env.example`) before starting the
> ELK services.

---

## Scripts

Both `scripts/deploy-testnet.sh` and `scripts/verify-deployment.sh` read from
the canonical env file:

```bash
# Use default (.env.testnet)
./scripts/deploy-testnet.sh

# Use a custom env file
ENV_FILE=.env.staging ./scripts/deploy-testnet.sh

# Verify using the same canonical values
./scripts/verify-deployment.sh
```

After deployment, `deploy-testnet.sh` writes the new `FACTORY_CONTRACT_ID`
back to the canonical env file and also patches `frontend/.env` if it exists,
keeping all consumers in sync automatically.
