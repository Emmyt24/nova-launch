/**
 * Backend startup — JWT secret production guard (Issue #1887)
 *
 * docker-compose.yml ships fallback literals for JWT_SECRET
 * (`change-me-in-production`) and ADMIN_JWT_SECRET
 * (`change-me-admin-in-production`). Both are committed to a public repo, so a
 * production process started with either must fail fast via validateEnv().
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Runs validateEnv() with the given env overrides, isolated from other tests. */
async function runValidateEnv(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', env.NODE_ENV ?? 'production');
  vi.stubEnv('STELLAR_NETWORK', env.STELLAR_NETWORK ?? 'testnet');
  vi.stubEnv('FACTORY_CONTRACT_ID', env.FACTORY_CONTRACT_ID ?? 'C' + 'A'.repeat(55));
  vi.stubEnv('DATABASE_URL', env.DATABASE_URL ?? 'postgresql://localhost/test');
  vi.stubEnv('JWT_SECRET', env.JWT_SECRET ?? 'super-secret-jwt-key-for-testing');
  vi.stubEnv('ADMIN_JWT_SECRET', env.ADMIN_JWT_SECRET ?? 'super-secret-admin-key-for-testing');

  const { validateEnv } = await import('../config/env');
  return validateEnv();
}

describe('Backend startup — JWT secret production guard', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws in production when JWT_SECRET is the docker-compose default', async () => {
    await expect(
      runValidateEnv({ JWT_SECRET: 'change-me-in-production' })
    ).rejects.toThrow(/JWT_SECRET must be set to a secure value in production/);
  });

  it('throws in production when ADMIN_JWT_SECRET is the docker-compose default', async () => {
    await expect(
      runValidateEnv({ ADMIN_JWT_SECRET: 'change-me-admin-in-production' })
    ).rejects.toThrow(/ADMIN_JWT_SECRET must be set to a secure value in production/);
  });

  it('throws in production when either secret is empty', async () => {
    await expect(runValidateEnv({ JWT_SECRET: '' })).rejects.toThrow(/JWT_SECRET/);
    await expect(runValidateEnv({ ADMIN_JWT_SECRET: '' })).rejects.toThrow(
      /ADMIN_JWT_SECRET/
    );
  });

  it('still throws for the legacy placeholder secret', async () => {
    await expect(
      runValidateEnv({ JWT_SECRET: 'your-secret-key-change-in-production' })
    ).rejects.toThrow(/JWT_SECRET/);
  });

  it('accepts strong secrets in production', async () => {
    const env = await runValidateEnv({
      JWT_SECRET: 'a-real-long-random-production-secret',
      ADMIN_JWT_SECRET: 'a-different-real-long-random-admin-secret',
    });
    expect(env.JWT_SECRET).toBe('a-real-long-random-production-secret');
    expect(env.ADMIN_JWT_SECRET).toBe('a-different-real-long-random-admin-secret');
  });

  it('does not enforce the guard outside production', async () => {
    const env = await runValidateEnv({
      NODE_ENV: 'development',
      JWT_SECRET: 'change-me-in-production',
      ADMIN_JWT_SECRET: 'change-me-admin-in-production',
    });
    expect(env.NODE_ENV).toBe('development');
  });
});
