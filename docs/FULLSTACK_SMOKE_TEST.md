# Fullstack Deployment Smoke Test

Single-command verification that a token deploy flows end-to-end: chain submission → backend event ingestion → indexed API read.

---

## What it covers

| Phase | What is verified |
|-------|-----------------|
| 1 | `create_token` on the factory contract succeeds and returns a valid Soroban address |
| 2 | Token account is reachable on Horizon / contract state is readable |
| 3 | Backend event listener ingests the `tok_reg` event and indexes the token |
| 4 | `GET /api/tokens/search` returns the token with matching address, creator, and symbol |

---

## Prerequisites

- `soroban` CLI installed with an `admin` identity configured
- `.env.testnet` at the repo root with `FACTORY_CONTRACT_ID` set (written by `deploy-testnet.sh`)
- Backend running with `ENABLE_EVENT_LISTENER=true`

---

## Quick start

```bash
# 1. Deploy the contract if not already done
./scripts/deploy-testnet.sh

# 2. Start the backend (separate terminal)
cd backend && npm run dev

# 3. Run the smoke test
./scripts/fullstack-smoke-test.sh
```

### Options

```
--network testnet|mainnet   Target network (default: testnet)
--verbose                   Show full soroban CLI output
```

### Environment overrides

| Variable | Default | Purpose |
|----------|---------|---------|
| `FACTORY_CONTRACT_ID` | from `.env.testnet` | Factory contract to invoke |
| `BACKEND_URL` | `http://localhost:3001` | Backend API base URL |
| `INGESTION_TIMEOUT` | `30` | Seconds to wait for backend ingestion |
| `ENV_FILE` | `.env.testnet` | Canonical env file path |

---

## Expected output

```
── Phase 1: Deploy token on-chain ──
[smoke] Factory:  C...
[smoke] Network:  testnet
[smoke] Symbol:   SMK12345
  ✓ Token deployed: C...

── Phase 2: Confirm token on-chain via Horizon ──
  ✓ Factory contract state readable — on-chain confirmation passed

── Phase 3: Wait for backend event ingestion ──
[smoke] Polling .../api/tokens/search?q=SMK12345 (timeout: 30s)
  ✓ Token indexed by backend (symbol: SMK12345)

── Phase 4: Verify frontend-readable API state ──
  ✓ API response shape valid (success: true)
  ✓ Indexed token address matches deployed address (C...)
  ✓ Creator address matches admin (G...)

══════════════════════════════════════════
  Fullstack Smoke Test — Summary
══════════════════════════════════════════
  Token:    C...
  Symbol:   SMK12345
  Network:  testnet
  Duration: 18s
  Passed:   6
  Failed:   0
══════════════════════════════════════════
✓ All checks passed — stack is healthy
```

---

## Frontend e2e test

The Vitest test at `frontend/src/test/e2e/token-deployment.e2e.test.ts` covers the same four phases from the TypeScript layer. It requires `VITE_FACTORY_CONTRACT_ID` and `VITE_BACKEND_URL` in `frontend/.env`.

```bash
cd frontend
npx vitest run src/test/e2e/token-deployment.e2e.test.ts
```

---

## Troubleshooting

**Token not indexed within timeout**
- Confirm `ENABLE_EVENT_LISTENER=true` in `backend/.env`
- Check backend logs for `tok_reg` event processing
- Increase `INGESTION_TIMEOUT` if the network is slow

**`FACTORY_CONTRACT_ID` not set**
- Run `./scripts/deploy-testnet.sh` — it writes `.env.testnet` automatically

**`admin` identity not found**
- Run `./scripts/setup-soroban.sh` to generate and fund the admin key
