# Production Integration Runbook

End-to-end checklist for deploying Nova Launch to production. Follow steps in order. Each section has a checkpoint — do not proceed until it passes.

---

## Prerequisites

Before starting, confirm:

- [ ] You have `soroban` CLI installed and `admin` identity configured
- [ ] You have funded mainnet accounts (`admin`, `treasury`)
- [ ] `STELLAR_NETWORK=mainnet` is set in your shell or `.env.mainnet`
- [ ] The WASM artifact is built and optimized (see Step 1)
- [ ] Backend `.env` is populated (see `backend/.env.example`)
- [ ] Frontend `.env` is populated (see `frontend/.env.example`)

---

## Step 1 — Build and Optimize Contract

```bash
cd contracts/token-factory
cargo build --target wasm32-unknown-unknown --release
soroban contract optimize \
  --wasm target/wasm32-unknown-unknown/release/token_factory.wasm
```

**Checkpoint:** File `target/wasm32-unknown-unknown/release/token_factory.optimized.wasm` exists and is non-zero.

---

## Step 2 — Deploy Contract

```bash
# From repo root
STELLAR_NETWORK=mainnet ./scripts/deploy-testnet.sh
```

> The script writes `deployment-mainnet.json` and `.env.mainnet` with the new contract ID.

**Checkpoint:**

```bash
cat deployment-mainnet.json | jq .contractId
# Expected: 56-character string starting with "C"
```

---

## Step 3 — Update Frontend Environment

```bash
./scripts/update-frontend-env.sh
# Then copy mainnet values:
cp .env.mainnet frontend/.env
```

Verify `frontend/.env` contains:

```
VITE_FACTORY_CONTRACT_ID=<56-char contract ID>
VITE_NETWORK=mainnet
```

**Checkpoint:** `grep VITE_FACTORY_CONTRACT_ID frontend/.env` returns the contract ID from Step 2.

---

## Step 4 — Run Database Migrations

```bash
cd backend
npx prisma migrate deploy
```

**Checkpoint:** Command exits 0. No pending migrations remain:

```bash
npx prisma migrate status
# Expected: "All migrations have been applied"
```

---

## Step 5 — Start Backend and Event Listener

```bash
cd backend
ENABLE_EVENT_LISTENER=true npm start
```

**Checkpoint:**

```bash
curl -s http://localhost:3000/health | jq .data.status
# Expected: "ok"
```

---

## Step 6 — Build and Deploy Frontend

```bash
cd frontend
npm run build
# Deploy dist/ to your hosting provider (Vercel, Netlify, etc.)
vercel --prod   # or equivalent
```

**Checkpoint:** The deployed URL loads without a blank screen or boot error banner.

---

## Step 7 — Smoke Test

Run the full smoke test against the live deployment:

```bash
STELLAR_NETWORK=mainnet \
FACTORY_CONTRACT_ID=$(jq -r .contractId deployment-mainnet.json) \
./scripts/smoke-test.sh
```

Expected output: all checks pass with `✓`.

For a full frontend + backend + chain integration check:

```bash
./scripts/fullstack-smoke-test.sh
```

**Checkpoint:** No `✗` lines in output.

---

## Step 8 — Verify Deployment

```bash
./scripts/verify-deployment.sh
```

**Checkpoint:** Script exits 0 and prints `Deployment verified`.

---

## Rollback

If any step fails after contract deployment:

```bash
# Find the backup created by upgrade-contract.sh or deploy-testnet.sh
ls backups/

# Restore previous contract
./scripts/rollback-upgrade.sh backups/<timestamp> mainnet
```

After rollback:

1. Re-run Step 3 to point frontend at the restored contract ID.
2. Re-run Step 7 smoke test to confirm the rollback is functional.

> See [rollback-upgrade.sh](../scripts/rollback-upgrade.sh) for details.

---

## Post-Deploy Verification Checklist

| Check | Command | Expected |
|-------|---------|----------|
| Contract state | `soroban contract invoke --id $CONTRACT_ID --network mainnet -- get_state` | JSON with `is_paused: false` |
| Backend health | `curl /health` | `{"data":{"status":"ok",...}}` |
| Frontend loads | Open deployed URL | No error banner |
| Wallet connects | Connect Freighter | Address shown in header |
| Fee display | Open Deploy page | Shows 7 XLM base fee |
| Explorer links | Click any tx link | Opens stellar.expert/explorer/public |

---

## Environment Variable Reference

| Variable | Where | Description |
|----------|-------|-------------|
| `STELLAR_NETWORK` | shell / `.env.mainnet` | `testnet` or `mainnet` |
| `FACTORY_CONTRACT_ID` | `.env.mainnet` | Deployed contract address |
| `VITE_FACTORY_CONTRACT_ID` | `frontend/.env` | Same value, Vite prefix |
| `VITE_NETWORK` | `frontend/.env` | `testnet` or `mainnet` |
| `ENABLE_EVENT_LISTENER` | backend env | `true` to start chain listener |
| `DATABASE_URL` | backend env | Postgres connection string |

---

## Related Scripts

| Script | Purpose |
|--------|---------|
| `scripts/deploy-testnet.sh` | Deploy contract (works for mainnet via `STELLAR_NETWORK=mainnet`) |
| `scripts/update-frontend-env.sh` | Sync contract ID to `frontend/.env` |
| `scripts/rollback-upgrade.sh` | Restore previous contract from backup |
| `scripts/smoke-test.sh` | Contract-level smoke tests |
| `scripts/fullstack-smoke-test.sh` | Frontend + backend + chain integration |
| `scripts/verify-deployment.sh` | Post-deploy verification |

---

## High API Error Rate

Triggered by `alertHighApiErrorRate` (PagerDuty event type `api-error-rate-high`, P2/error severity).

Symptoms:

- Backend 5xx rate exceeds the configured threshold (5% in production, 20% in staging).
- PagerDuty incident fired with dedup key `nova-api-high-error-rate`.

Triage:

1. Check the API CloudWatch dashboard (`module.monitoring.api_dashboard_name`) for the error-rate and latency panels.
2. Correlate the spike with a recent deploy (`kubectl rollout history` / ECS task revisions) or a downstream dependency outage.
3. Pull recent structured logs with the same `correlationId` to find the failing endpoints.
4. If a single endpoint is responsible, throttle or disable the feature flag; otherwise roll back the last deploy.

## Database Connection Pool Exhausted

Triggered by `alertDatabasePoolExhausted` (PagerDuty event type equivalent to `db-connection-loss`, P1/critical severity).

Symptoms:

- Prisma reports no available connections (`TimedOut fetching a new connection` / pool exhausted).
- PagerDuty incident fired with dedup key `nova-db-pool-exhausted`.

Triage:

1. Check the RDS instance metrics (connections, CPU, freeable memory) and the `backend_log_group_name` for pool-wait timeouts.
2. Confirm no long-running migration or batch job is holding connections open.
3. Scale the connection limit or restart the backend service to recycle leaked connections.
4. If the database itself is unhealthy, follow the DB-connection-loss runbook and fail over to the standby.
