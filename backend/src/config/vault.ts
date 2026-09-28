/**
 * HashiCorp Vault Secret Manager — Nova Launch
 * Issue: #896
 *
 * Fetches secrets from Vault via AppRole auth and caches them with TTL.
 * Falls back to environment variables for local development.
 */

interface VaultSecret {
  value: string;
  expiresAt: number; // epoch ms
}

interface VaultKvResponse {
  data: { data: Record<string, string> };
}

/** Vault client with AppRole auth, KV-v2 reads, and in-memory caching. */
export class VaultClient {
  private static instance: VaultClient;
  private cache = new Map<string, VaultSecret>();
  private clientToken: string | null = null;
  private tokenExpiresAt = 0;

  private readonly addr: string;
  private readonly roleId: string;
  private readonly secretId: string;
  private readonly cacheTtlMs: number;
  private readonly mountPath: string;

  private constructor() {
    this.addr       = process.env.VAULT_ADDR       ?? 'http://127.0.0.1:8200';
    this.roleId     = process.env.VAULT_ROLE_ID    ?? '';
    this.secretId   = process.env.VAULT_SECRET_ID  ?? '';
    const _rawTtl   = parseInt(process.env.VAULT_CACHE_TTL_MS ?? '300000', 10);
    if (Number.isFinite(_rawTtl) && _rawTtl > 0) {
      this.cacheTtlMs = _rawTtl;
    } else {
      console.warn(
        `[VaultClient] VAULT_CACHE_TTL_MS env var is malformed ` +
        `("${process.env.VAULT_CACHE_TTL_MS}") — falling back to default of 300000ms`
      );
      this.cacheTtlMs = 300000;
    }
    this.mountPath  = process.env.VAULT_MOUNT_PATH ?? 'nova';
  }

  static getInstance(): VaultClient {
    if (!VaultClient.instance) VaultClient.instance = new VaultClient();
    return VaultClient.instance;
  }

  /** Returns true when Vault is configured (role_id + secret_id present). */
  get isEnabled(): boolean {
    return Boolean(this.roleId && this.secretId);
  }

  // ── AppRole authentication ─────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    if (this.clientToken && Date.now() < this.tokenExpiresAt) return;

    const res = await fetch(`${this.addr}/v1/auth/approle/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_id: this.roleId, secret_id: this.secretId }),
    });

    if (!res.ok) {
      throw new Error(`Vault AppRole login failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { auth: { client_token: string; lease_duration: number } };
    this.clientToken    = body.auth.client_token;
    // Renew 60 s before expiry
    this.tokenExpiresAt = Date.now() + (body.auth.lease_duration - 60) * 1000;
  }

  // ── KV-v2 read ─────────────────────────────────────────────────────────────

  async getSecrets(path: string): Promise<Record<string, string>> {
    const cacheKey = `kv:${path}`;
    const cached   = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return JSON.parse(cached.value) as Record<string, string>;
    }

    await this.authenticate();

    const res = await fetch(`${this.addr}/v1/${this.mountPath}/data/${path}`, {
      headers: { 'X-Vault-Token': this.clientToken! },
    });

    if (!res.ok) {
      throw new Error(`Vault KV read failed [${path}]: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as VaultKvResponse;
    const secrets = body.data.data;

    this.cache.set(cacheKey, {
      value:     JSON.stringify(secrets),
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    return secrets;
  }

  /** Convenience: get a single secret value. */
  async getSecret(path: string, key: string): Promise<string> {
    const secrets = await this.getSecrets(path);
    const value   = secrets[key];
    if (value === undefined) throw new Error(`Secret key '${key}' not found at path '${path}'`);
    return value;
  }

  /** Invalidate cached secrets for a path (e.g. after rotation). */
  invalidate(path?: string): void {
    if (path) {
      this.cache.delete(`kv:${path}`);
    } else {
      this.cache.clear();
    }
  }
}

// ── Secret loader ─────────────────────────────────────────────────────────────

export interface AppSecrets {
  JWT_SECRET: string;
  ADMIN_JWT_SECRET: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  STELLAR_NETWORK: string;
  STELLAR_HORIZON_URL: string;
  FACTORY_CONTRACT_ID: string;
  SENTRY_DSN: string;
}

/**
 * Load secrets from Vault when available, otherwise fall back to env vars.
 * Call once at application startup.
 */
export async function loadSecrets(): Promise<AppSecrets> {
  const vault = VaultClient.getInstance();

  if (!vault.isEnabled) {
    // Local dev / CI — use environment variables directly
    return {
      JWT_SECRET:           process.env.JWT_SECRET           ?? 'dev-secret',
      ADMIN_JWT_SECRET:     process.env.ADMIN_JWT_SECRET     ?? 'dev-admin-secret',
      DATABASE_URL:         process.env.DATABASE_URL         ?? '',
      REDIS_URL:            process.env.REDIS_URL            ?? 'redis://localhost:6379',
      STELLAR_NETWORK:      process.env.STELLAR_NETWORK      ?? 'testnet',
      STELLAR_HORIZON_URL:  process.env.STELLAR_HORIZON_URL  ?? 'https://horizon-testnet.stellar.org',
      FACTORY_CONTRACT_ID:  process.env.FACTORY_CONTRACT_ID  ?? '',
      SENTRY_DSN:           process.env.SENTRY_DSN           ?? '',
    };
  }

  const [backend, stellar, observability] = await Promise.all([
    vault.getSecrets('backend'),
    vault.getSecrets('stellar'),
    vault.getSecrets('observability').catch(() => ({} as Record<string, string>)),
  ]);

  return {
    JWT_SECRET:           backend.JWT_SECRET           ?? '',
    ADMIN_JWT_SECRET:     backend.ADMIN_JWT_SECRET     ?? '',
    DATABASE_URL:         backend.DATABASE_URL         ?? '',
    REDIS_URL:            backend.REDIS_URL            ?? 'redis://localhost:6379',
    STELLAR_NETWORK:      stellar.STELLAR_NETWORK      ?? 'testnet',
    STELLAR_HORIZON_URL:  stellar.STELLAR_HORIZON_URL  ?? 'https://horizon-testnet.stellar.org',
    FACTORY_CONTRACT_ID:  stellar.FACTORY_CONTRACT_ID  ?? '',
    SENTRY_DSN:           observability.SENTRY_DSN     ?? '',
  };
}
