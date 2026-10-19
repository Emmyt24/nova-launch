/**
 * Typed runtime environment parsing and production-safe defaults.
 *
 * `startupValidation.ts` is authoritative for the deployment manifest of required variables and
 * dependency probes. Boot calls its `validateEnvVars()` first, then this module's `validateEnv()`
 * to construct `BackendEnv`, and finally `runStartupValidation()` before listening. Requirements
 * enforced here are runtime invariants or environment-dependent defaults, not a second manifest.
 */

type Network = 'testnet' | 'mainnet';

const NETWORK_DEFAULTS: Record<Network, { horizonUrl: string; sorobanRpcUrl: string; networkPassphrase: string }> = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  },
};

export type ExplorerProvider = 'stellar.expert' | 'stellarchain';

export const SUPPORTED_EXPLORER_PROVIDERS: readonly ExplorerProvider[] = [
  'stellar.expert',
  'stellarchain',
];
export type PinningProviderName = 'pinata' | 'web3storage' | 'none';

const PINNING_PROVIDER_NAMES: readonly PinningProviderName[] = ['pinata', 'web3storage', 'none'];

export interface BackendEnv {
  NODE_ENV: string;
  PORT: number;
  STELLAR_NETWORK: Network;
  STELLAR_HORIZON_URL: string;
  STELLAR_SOROBAN_RPC_URL: string;
  STELLAR_NETWORK_PASSPHRASE: string;
  STELLAR_EXPLORER_PROVIDER: ExplorerProvider;
  STELLAR_EXPLORER_BASE_URL?: string;
  FACTORY_CONTRACT_ID: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  ADMIN_JWT_SECRET: string;
  /** Primary IPFS pinning provider. Defaults to `pinata`. */
  PINNING_PRIMARY_PROVIDER: PinningProviderName;
  /** Optional failover provider used when the primary keeps failing. */
  PINNING_SECONDARY_PROVIDER: PinningProviderName;
  /** Number of consecutive primary failures before failing over. */
  PINNING_FAILOVER_THRESHOLD: number;
  /** Pinata credentials (primary or secondary depending on selection). */
  PINATA_API_KEY: string;
  PINATA_API_SECRET: string;
  PINATA_GATEWAY_URL: string;
  /** web3.storage credentials (primary or secondary depending on selection). */
  WEB3STORAGE_API_TOKEN: string;
  WEB3STORAGE_GATEWAY_URL: string;
}

function parsePinningProvider(name: string, raw: string | undefined, fallback: PinningProviderName): PinningProviderName {
  const value = (raw || fallback).trim().toLowerCase();
  if (!PINNING_PROVIDER_NAMES.includes(value as PinningProviderName)) {
    throw new Error(
      `${name} must be one of ${PINNING_PROVIDER_NAMES.map((p) => `"${p}"`).join(', ')}, got "${raw}".`
    );
  }
  return value as PinningProviderName;
}

function assertProviderCredentials(
  provider: PinningProviderName,
  role: 'PINNING_PRIMARY_PROVIDER' | 'PINNING_SECONDARY_PROVIDER',
  isProduction: boolean,
  credentials: { pinataKey: string; pinataSecret: string; web3Token: string }
): void {
  if (provider === 'none') {
    if (role === 'PINNING_PRIMARY_PROVIDER' && isProduction) {
      throw new Error(
        'PINNING_PRIMARY_PROVIDER cannot be "none" in production — configure a pinning provider.'
      );
    }
    return;
  }
  if (provider === 'pinata' && (!credentials.pinataKey || !credentials.pinataSecret)) {
    throw new Error(
      `PINATA_API_KEY and PINATA_API_SECRET are required when ${role} is "pinata".`
    );
  }
  if (provider === 'web3storage' && !credentials.web3Token) {
    throw new Error(
      `WEB3STORAGE_API_TOKEN is required when ${role} is "web3storage".`
    );
  }
}

/**
 * Secret values that are publicly known — placeholder strings and the fallback
 * literals committed in `docker-compose.yml`
 * (`JWT_SECRET: ${JWT_SECRET:-change-me-in-production}` /
 * `ADMIN_JWT_SECRET: ${ADMIN_JWT_SECRET:-change-me-admin-in-production}`).
 * Any of these reaching a `NODE_ENV=production` process means anyone can forge a
 * token, so `validateEnv()` fails fast on them.
 */
const INSECURE_SECRET_VALUES = new Set([
  'your-secret-key-change-in-production',
  'change-me-in-production',
  'change-me-admin-in-production',
  'dev-secret-key-change-me',
  'dev-admin-secret-key-change-me',
]);

function assertSecureProductionSecret(name: string, value: string): void {
  if (!value || INSECURE_SECRET_VALUES.has(value)) {
    throw new Error(
      `${name} must be set to a secure value in production` +
      (value ? ` — the committed default "${value}" is publicly known` : '') +
      '. Override it via .env / your environment (see .env.example).'
    );
  }
}

export function validateEnv(): BackendEnv {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const network = (process.env.STELLAR_NETWORK || 'testnet') as Network;
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`STELLAR_NETWORK must be "testnet" or "mainnet", got "${network}"`);
  }

  const defaults = NETWORK_DEFAULTS[network];

  const rawExplorerProvider = process.env.STELLAR_EXPLORER_PROVIDER || 'stellar.expert';
  if (!SUPPORTED_EXPLORER_PROVIDERS.includes(rawExplorerProvider as ExplorerProvider)) {
    throw new Error(
      `STELLAR_EXPLORER_PROVIDER must be one of ${SUPPORTED_EXPLORER_PROVIDERS.map((p) => `"${p}"`).join(', ')}, ` +
      `got "${rawExplorerProvider}".`
    );
  }
  const explorerProvider = rawExplorerProvider as ExplorerProvider;

  const rawExplorerBaseUrl = process.env.STELLAR_EXPLORER_BASE_URL;
  let explorerBaseUrl: string | undefined;
  if (rawExplorerBaseUrl) {
    try {
      const parsed = new URL(rawExplorerBaseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
      explorerBaseUrl = rawExplorerBaseUrl.replace(/\/+$/, '');
    } catch {
      throw new Error(
        `STELLAR_EXPLORER_BASE_URL must be a valid http(s) URL, got "${rawExplorerBaseUrl}".`
      );
    }
  }

  const factoryContractId = process.env.FACTORY_CONTRACT_ID || '';
  if (isProduction && !factoryContractId) {
    throw new Error(
      'FACTORY_CONTRACT_ID is required in production. ' +
      'Set it in your environment after deploying the contract.'
    );
  }
  if (factoryContractId && !/^C[A-Z2-7]{55}$/.test(factoryContractId)) {
    throw new Error(
      `FACTORY_CONTRACT_ID is malformed: "${factoryContractId}". ` +
      'Expected a 56-character Soroban contract ID starting with "C".'
    );
  }

  const databaseUrl =
    process.env.DATABASE_URL ||
    (isProduction
      ? ''
      : 'postgresql://postgres:postgres@localhost:5432/postgres?schema=public');
  if (isProduction && !databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const jwtSecret =
    process.env.JWT_SECRET ||
    (isProduction ? '' : 'dev-secret-key-change-me');
  // Guard against the dev-mode default above ever reaching production —
  // whether JWT_SECRET was left unset (falls through to the dev default)
  // or someone copied that literal string into a real .env believing it
  // was just a placeholder.
  if (
    isProduction &&
    (!jwtSecret || jwtSecret === 'dev-secret-key-change-me')
  ) {
    throw new Error('JWT_SECRET must be set to a secure value in production.');
  }

  const adminJwtSecret =
    process.env.ADMIN_JWT_SECRET ||
    (isProduction ? '' : 'dev-admin-secret-key-change-me');
  if (
    isProduction &&
    (!adminJwtSecret || INSECURE_SECRET_VALUES.has(adminJwtSecret))
  ) {
    throw new Error('ADMIN_JWT_SECRET must be set to a secure value in production.');
  }

  const pinningPrimaryProvider = parsePinningProvider(
    'PINNING_PRIMARY_PROVIDER',
    process.env.PINNING_PRIMARY_PROVIDER,
    'pinata'
  );
  const pinningSecondaryProvider = parsePinningProvider(
    'PINNING_SECONDARY_PROVIDER',
    process.env.PINNING_SECONDARY_PROVIDER,
    'none'
  );
  if (
    pinningSecondaryProvider !== 'none' &&
    pinningSecondaryProvider === pinningPrimaryProvider
  ) {
    throw new Error(
      `PINNING_SECONDARY_PROVIDER must differ from PINNING_PRIMARY_PROVIDER (both are "${pinningPrimaryProvider}").`
    );
  }

  const pinataApiKey = process.env.PINATA_API_KEY || '';
  const pinataApiSecret = process.env.PINATA_API_SECRET || '';
  const web3StorageApiToken = process.env.WEB3STORAGE_API_TOKEN || '';
  const pinningCredentials = {
    pinataKey: pinataApiKey,
    pinataSecret: pinataApiSecret,
    web3Token: web3StorageApiToken,
  };
  assertProviderCredentials(pinningPrimaryProvider, 'PINNING_PRIMARY_PROVIDER', isProduction, pinningCredentials);
  assertProviderCredentials(pinningSecondaryProvider, 'PINNING_SECONDARY_PROVIDER', isProduction, pinningCredentials);

  const rawFailoverThreshold = process.env.PINNING_FAILOVER_THRESHOLD || '3';
  const parsedFailoverThreshold = parseInt(rawFailoverThreshold, 10);
  if (
    !Number.isFinite(parsedFailoverThreshold) ||
    !Number.isInteger(parsedFailoverThreshold) ||
    parsedFailoverThreshold < 1
  ) {
    throw new Error(
      `PINNING_FAILOVER_THRESHOLD must be a positive integer, got "${rawFailoverThreshold}".`
    );
  }

  const rawPort = process.env.PORT || '3001';
  const parsedPort = parseInt(rawPort, 10);
  if (
    !Number.isFinite(parsedPort) ||
    !Number.isInteger(parsedPort) ||
    parsedPort < 1 ||
    parsedPort > 65535
  ) {
    throw new Error(
      `PORT must be a valid integer between 1 and 65535, got "${rawPort}". ` +
      'Check your environment configuration.'
    );
  }

  return {
    NODE_ENV: nodeEnv,
    PORT: parsedPort,
    STELLAR_NETWORK: network,
    STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL || defaults.horizonUrl,
    STELLAR_SOROBAN_RPC_URL: process.env.STELLAR_SOROBAN_RPC_URL || defaults.sorobanRpcUrl,
    STELLAR_NETWORK_PASSPHRASE: process.env.STELLAR_NETWORK_PASSPHRASE || defaults.networkPassphrase,
    STELLAR_EXPLORER_PROVIDER: explorerProvider,
    STELLAR_EXPLORER_BASE_URL: explorerBaseUrl,
    FACTORY_CONTRACT_ID: factoryContractId,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    ADMIN_JWT_SECRET: adminJwtSecret,
    PINNING_PRIMARY_PROVIDER: pinningPrimaryProvider,
    PINNING_SECONDARY_PROVIDER: pinningSecondaryProvider,
    PINNING_FAILOVER_THRESHOLD: parsedFailoverThreshold,
    PINATA_API_KEY: pinataApiKey,
    PINATA_API_SECRET: pinataApiSecret,
    PINATA_GATEWAY_URL: process.env.PINATA_GATEWAY_URL || 'https://gateway.pinata.cloud',
    WEB3STORAGE_API_TOKEN: web3StorageApiToken,
    WEB3STORAGE_GATEWAY_URL: process.env.WEB3STORAGE_GATEWAY_URL || 'https://w3s.link',
  };
}
