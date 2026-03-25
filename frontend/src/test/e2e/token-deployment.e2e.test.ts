/**
 * Token Deployment E2E — Fullstack Integration
 *
 * Reconciles the frontend deployment flow with real contract state and
 * backend-indexed data. All assertions are anchored to the deployed
 * token address and transaction hash — no brittle timers.
 *
 * Phases:
 *   1. Deploy token via factory contract → capture tokenAddress + txHash
 *   2. Confirm token exists on-chain via StellarService
 *   3. Verify backend search API returns the indexed token
 *   4. Assert frontend-readable fields (address, creator, symbol) are consistent
 *
 * Run:
 *   npx vitest run src/test/e2e/token-deployment.e2e.test.ts
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { StellarService } from '../../services/stellar.service';

// ── Config ────────────────────────────────────────────────────────────────────
// Read from env so the test works against any network without hardcoding values.
// Set VITE_NETWORK, VITE_FACTORY_CONTRACT_ID, VITE_BACKEND_URL in frontend/.env
// or pass them as environment variables in CI.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : {}) as Record<string, string>;

const NETWORK = (_env['VITE_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet';
const BACKEND_URL = _env['VITE_BACKEND_URL'] ?? 'http://localhost:3001';
const FACTORY_CONTRACT_ID = _env['VITE_FACTORY_CONTRACT_ID'] ?? '';

// Unique symbol per run so replays don't collide with prior indexed tokens
const RUN_SUFFIX = Date.now().toString().slice(-5);
const SMOKE_SYMBOL = `SMK${RUN_SUFFIX}`;
const SMOKE_NAME = `Smoke Test Token ${SMOKE_SYMBOL}`;
const INITIAL_SUPPLY = '1000000';

// ── Ingestion polling ─────────────────────────────────────────────────────────
const INGESTION_TIMEOUT_MS = 30_000;
const INGESTION_POLL_MS = 3_000;

async function pollBackendForToken(
  symbol: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await fetch(
      `${BACKEND_URL}/api/tokens/search?q=${encodeURIComponent(symbol)}&limit=5`,
      { headers: { Accept: 'application/json' } },
    ).catch(() => null);

    if (resp?.ok) {
      const body = (await resp.json()) as { success: boolean; data: Record<string, unknown>[] };
      const match = body.data?.find((t) => t['symbol'] === symbol);
      if (match) return match;
    }

    await new Promise((r) => setTimeout(r, INGESTION_POLL_MS));
  }
  return null;
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe('Token Deployment — Fullstack Smoke', () => {
  let stellar: StellarService;
  let deployedAddress: string;
  let creatorPublicKey: string;

  beforeAll(async () => {
    if (!FACTORY_CONTRACT_ID) {
      throw new Error(
        'VITE_FACTORY_CONTRACT_ID is not set. Deploy the contract first and update frontend/.env.',
      );
    }
    stellar = new StellarService(NETWORK);
    const testAccount = await stellar.createTestAccount();
    await stellar.fundTestAccount(testAccount.publicKey);
    creatorPublicKey = testAccount.publicKey;
  }, 30_000);

  // ── Phase 1: Deploy ──────────────────────────────────────────────────────────
  it('deploys a token via the factory contract and returns a tx hash', async () => {
    const result = await stellar.deployToken({
      name: SMOKE_NAME,
      symbol: SMOKE_SYMBOL,
      decimals: 7,
      initialSupply: INITIAL_SUPPLY,
      creatorAddress: creatorPublicKey,
      feePayment: 70_000_000n,
    });

    expect(result.tokenAddress).toBeTruthy();
    expect(result.tokenAddress).toMatch(/^C[A-Z0-9]{55}$/);
    expect(result.transactionHash).toBeTruthy();
    expect(typeof result.transactionHash).toBe('string');

    deployedAddress = result.tokenAddress;
  }, 30_000);

  // ── Phase 2: On-chain confirmation ───────────────────────────────────────────
  it('confirms the deployed token exists on-chain', async () => {
    expect(deployedAddress).toBeTruthy();

    const exists = await stellar.verifyTokenExists(deployedAddress);
    expect(exists).toBe(true);
  }, 15_000);

  it('initial supply is readable on-chain', async () => {
    const balance = await stellar.getTokenBalance(deployedAddress, creatorPublicKey);
    expect(balance).toBe(INITIAL_SUPPLY);
  }, 15_000);

  // ── Phase 3: Backend ingestion ───────────────────────────────────────────────
  it('backend indexes the token within the ingestion window', async () => {
    const indexed = await pollBackendForToken(SMOKE_SYMBOL, INGESTION_TIMEOUT_MS);
    expect(indexed).not.toBeNull();
  }, INGESTION_TIMEOUT_MS + 5_000);

  // ── Phase 4: Frontend-readable API state ─────────────────────────────────────
  it('indexed token address matches the deployed address', async () => {
    const indexed = await pollBackendForToken(SMOKE_SYMBOL, INGESTION_TIMEOUT_MS);
    expect(indexed).not.toBeNull();
    expect(indexed!['address']).toBe(deployedAddress);
  }, INGESTION_TIMEOUT_MS + 5_000);

  it('indexed creator matches the deploying account', async () => {
    const indexed = await pollBackendForToken(SMOKE_SYMBOL, INGESTION_TIMEOUT_MS);
    expect(indexed!['creator']).toBe(creatorPublicKey);
  }, INGESTION_TIMEOUT_MS + 5_000);

  it('indexed symbol and name are correct', async () => {
    const indexed = await pollBackendForToken(SMOKE_SYMBOL, INGESTION_TIMEOUT_MS);
    expect(indexed!['symbol']).toBe(SMOKE_SYMBOL);
    expect(indexed!['name']).toBe(SMOKE_NAME);
  }, INGESTION_TIMEOUT_MS + 5_000);

  it('indexed initial supply matches deployed supply', async () => {
    const indexed = await pollBackendForToken(SMOKE_SYMBOL, INGESTION_TIMEOUT_MS);
    // Backend serialises BigInt as string
    expect(String(indexed!['initialSupply'])).toBe(INITIAL_SUPPLY);
  }, INGESTION_TIMEOUT_MS + 5_000);
});
