# Production Readiness Gate

A single command that must pass before any release is cut.

```bash
./scripts/run-production-readiness-gate.sh [--network testnet|mainnet] [--backend-url URL]
```

Exit code `0` = safe to release. Exit code `1` = do not release.

---

## What the Gate Checks

| # | Check | Failure means |
|---|-------|---------------|
| 1 | **Contract ID** — `FACTORY_CONTRACT_ID` is set and matches the 56-char Soroban format | Wrong or missing contract address; every on-chain call will fail |
| 2 | **Frontend build** — `npm run build` succeeds | Users will see a broken or blank app |
| 3 | **Frontend tests** — full Vitest suite passes | Regressions in UI logic or service layer |
| 4 | **Contract ABI** — all required methods present in `factoryAbi.ts` | Frontend will call non-existent contract methods at runtime |
| 5 | **Backend health** — `/health` returns a healthy status | Backend is down or misconfigured |
| 6 | **Contract reachability** — `get_state` succeeds on the target network | Contract not deployed, wrong network, or RPC outage |
| 7 | **Ingestion lag metric** — `nova_launch_event_ingestion_lag_seconds` present in `/metrics` | Event listener is not running; projections will drift |
| 8 | **Webhook reliability** — exhausted delivery counter is zero | Subscriber endpoints are unreachable; integrators will miss events |

Checks 6–8 require a live backend. If the backend is not reachable, those checks are skipped with a warning rather than a hard failure — they are mandatory for production releases but optional for local pre-flight.

---

## How to Run

### Local pre-flight (no live backend)
```bash
FACTORY_CONTRACT_ID=C... ./scripts/run-production-readiness-gate.sh
```

### Against staging
```bash
FACTORY_CONTRACT_ID=C... \
BACKEND_URL=https://api-staging.nova-launch.io \
./scripts/run-production-readiness-gate.sh --network testnet
```

### Against production
```bash
FACTORY_CONTRACT_ID=C... \
BACKEND_URL=https://api.nova-launch.io \
./scripts/run-production-readiness-gate.sh --network mainnet
```

### In CI
The gate runs automatically on every `v*` tag push via the `readiness-gate` job in `.github/workflows/production-deploy.yml`. It can also be triggered manually from the Actions tab.

---

## Interpreting Failures

### `FACTORY_CONTRACT_ID is not set`
Set the env var or source the correct `.env.testnet` / `.env.mainnet` file.

### `FACTORY_CONTRACT_ID is malformed`
The address must be 56 characters, start with `C`, and use base32 characters `[A-Z2-7]`. Verify you copied the correct address for the target network.

### `Frontend build failed`
Run `cd frontend && npm run build` locally and fix the reported errors before releasing.

### `Frontend test suite has failures`
Run `cd frontend && npm test` and fix failing tests. Do not skip tests to unblock a release.

### `ABI missing required method: <method>`
The `frontend/src/contracts/factoryAbi.ts` file is out of sync with the deployed contract. Update the ABI to match the contract version being released.

### `Backend not reachable`
Ensure the backend service is running and `BACKEND_URL` points to the correct host. Check `docker-compose` or the deployment platform.

### `Contract get_state call failed`
The contract is not responding on the target network. Verify the contract is deployed, the network passphrase matches, and the RPC endpoint is healthy.

### `Ingestion lag metric missing`
The event listener (`StellarEventListener`) is not running or has not processed any events yet. Check backend logs for startup errors.

### `Webhook exhausted deliveries counter is non-zero`
One or more webhook subscribers are unreachable. Review `webhookDelivery` logs and contact affected integrators before releasing.
