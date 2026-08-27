/**
 * Contract ID Misconfiguration Tests — Backend Startup
 *
 * Verifies that the backend fails clearly and early when FACTORY_CONTRACT_ID
 * is empty, malformed, or structurally inconsistent with the configured network.
 *
 * Each failure names the exact misconfigured variable so the operator knows
 * immediately what to fix.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid 56-char Soroban contract ID. */
const VALID_CONTRACT_ID = 'C' + 'A'.repeat(55);

/** Runs validateEnv() with the given env overrides, isolated from other tests. */
async function runValidateEnv(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', env.NODE_ENV ?? 'production');
  vi.stubEnv('STELLAR_NETWORK', env.STELLAR_NETWORK ?? 'testnet');
  vi.stubEnv('FACTORY_CONTRACT_ID', env.FACTORY_CONTRACT_ID ?? '');
  vi.stubEnv('DATABASE_URL', env.DATABASE_URL ?? 'postgresql://localhost/test');
  vi.stubEnv('JWT_SECRET', env.JWT_SECRET ?? 'super-secret-jwt-key-for-testing');
  vi.stubEnv('ADMIN_JWT_SECRET', env.ADMIN_JWT_SECRET ?? 'super-secret-admin-jwt-key-for-testing');

  const { validateEnv } = await import('../config/env');
  return validateEnv();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Backend startup — FACTORY_CONTRACT_ID misconfiguration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // ── Empty contract ID ────────────────────────────────────────────────────

  it('throws in production when FACTORY_CONTRACT_ID is empty', async () => {
    await expect(
      runValidateEnv({ NODE_ENV: 'production', FACTORY_CONTRACT_ID: '' }),
    ).rejects.toThrow('FACTORY_CONTRACT_ID is required in production');
  });

  it('does not throw in development when FACTORY_CONTRACT_ID is empty', async () => {
    const env = await runValidateEnv({ NODE_ENV: 'development', FACTORY_CONTRACT_ID: '' });
    expect(env.FACTORY_CONTRACT_ID).toBe('');
  });

  // ── Malformed contract ID ────────────────────────────────────────────────

  it('throws when FACTORY_CONTRACT_ID does not start with "C"', async () => {
    await expect(
      runValidateEnv({ FACTORY_CONTRACT_ID: 'GABC123INVALID' }),
    ).rejects.toThrow('FACTORY_CONTRACT_ID is malformed');
  });

  it('throws when FACTORY_CONTRACT_ID is too short', async () => {
    await expect(
      runValidateEnv({ FACTORY_CONTRACT_ID: 'CSHORT' }),
    ).rejects.toThrow('FACTORY_CONTRACT_ID is malformed');
  });

  it('throws when FACTORY_CONTRACT_ID is too long', async () => {
    await expect(
      runValidateEnv({ FACTORY_CONTRACT_ID: 'C' + 'A'.repeat(56) }),
    ).rejects.toThrow('FACTORY_CONTRACT_ID is malformed');
  });

  it('throws when FACTORY_CONTRACT_ID contains invalid characters (lowercase)', async () => {
    const badId = 'C' + 'a'.repeat(55);
    await expect(
      runValidateEnv({ FACTORY_CONTRACT_ID: badId }),
    ).rejects.toThrow('FACTORY_CONTRACT_ID is malformed');
  });

  it('throws when FACTORY_CONTRACT_ID contains spaces', async () => {
    await expect(
      runValidateEnv({ FACTORY_CONTRACT_ID: 'C' + 'A'.repeat(54) + ' ' }),
    ).rejects.toThrow('FACTORY_CONTRACT_ID is malformed');
  });

  it('error message includes the bad value so the operator can identify it', async () => {
    const badId = 'NOT_A_CONTRACT_ID';
    await expect(
      runValidateEnv({ FACTORY_CONTRACT_ID: badId }),
    ).rejects.toThrow(badId);
  });

  // ── Valid contract ID ────────────────────────────────────────────────────

  it('accepts a valid 56-char contract ID on testnet', async () => {
    const env = await runValidateEnv({
      STELLAR_NETWORK: 'testnet',
      FACTORY_CONTRACT_ID: VALID_CONTRACT_ID,
    });
    expect(env.FACTORY_CONTRACT_ID).toBe(VALID_CONTRACT_ID);
    expect(env.STELLAR_NETWORK).toBe('testnet');
  });

  it('accepts a valid 56-char contract ID on mainnet', async () => {
    const env = await runValidateEnv({
      STELLAR_NETWORK: 'mainnet',
      FACTORY_CONTRACT_ID: VALID_CONTRACT_ID,
    });
    expect(env.FACTORY_CONTRACT_ID).toBe(VALID_CONTRACT_ID);
    expect(env.STELLAR_NETWORK).toBe('mainnet');
  });

  // ── Wrong-network contract ID (format-valid, wrong network) ─────────────

  it('throws when STELLAR_NETWORK is invalid regardless of contract ID', async () => {
    await expect(
      runValidateEnv({
        STELLAR_NETWORK: 'devnet',
        FACTORY_CONTRACT_ID: VALID_CONTRACT_ID,
      }),
    ).rejects.toThrow('STELLAR_NETWORK must be "testnet" or "mainnet"');
  });

  it('error message includes the bad STELLAR_NETWORK value', async () => {
    await expect(
      runValidateEnv({
        STELLAR_NETWORK: 'devnet',
        FACTORY_CONTRACT_ID: VALID_CONTRACT_ID,
      }),
    ).rejects.toThrow('"devnet"');
  });
});

// ---------------------------------------------------------------------------
// StellarEventListener module-load guard
// ---------------------------------------------------------------------------

describe('StellarEventListener — module-load contract ID guard', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws at module load when FACTORY_CONTRACT_ID is empty', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('FACTORY_CONTRACT_ID', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('JWT_SECRET', 'test-secret');

    await expect(import('../services/stellarEventListener')).rejects.toThrow(
      'FACTORY_CONTRACT_ID is empty',
    );
  });

  it('throws at module load when FACTORY_CONTRACT_ID is malformed', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('FACTORY_CONTRACT_ID', 'GBADCONTRACTID');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('JWT_SECRET', 'test-secret');

    await expect(import('../services/stellarEventListener')).rejects.toThrow(
      'FACTORY_CONTRACT_ID is malformed',
    );
  });

  it('error message names STELLAR_NETWORK so the operator knows which network to check', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STELLAR_NETWORK', 'mainnet');
    vi.stubEnv('FACTORY_CONTRACT_ID', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('JWT_SECRET', 'test-secret');

    await expect(import('../services/stellarEventListener')).rejects.toThrow(
      'STELLAR_NETWORK="mainnet"',
    );
  });

  it('loads successfully with a valid contract ID', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('FACTORY_CONTRACT_ID', VALID_CONTRACT_ID);
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('JWT_SECRET', 'test-secret');

    // Module should load without throwing
    await expect(import('../services/stellarEventListener')).resolves.toBeDefined();
  });
});
