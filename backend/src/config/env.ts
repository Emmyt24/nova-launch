/**
 * Backend environment validation.
 * Call `validateEnv()` once at startup; throws if required variables are absent.
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

export interface BackendEnv {
  NODE_ENV: string;
  PORT: number;
  STELLAR_NETWORK: Network;
  STELLAR_HORIZON_URL: string;
  STELLAR_SOROBAN_RPC_URL: string;
  STELLAR_NETWORK_PASSPHRASE: string;
  FACTORY_CONTRACT_ID: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  ADMIN_JWT_SECRET: string;
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

  return {
    NODE_ENV: nodeEnv,
    PORT: parseInt(process.env.PORT || '3001', 10),
    STELLAR_NETWORK: network,
    STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL || defaults.horizonUrl,
    STELLAR_SOROBAN_RPC_URL: process.env.STELLAR_SOROBAN_RPC_URL || defaults.sorobanRpcUrl,
    STELLAR_NETWORK_PASSPHRASE: process.env.STELLAR_NETWORK_PASSPHRASE || defaults.networkPassphrase,
    FACTORY_CONTRACT_ID: factoryContractId,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    ADMIN_JWT_SECRET: adminJwtSecret,
  };
}
