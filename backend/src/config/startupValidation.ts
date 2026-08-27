/**
 * Backend startup validation — validates all required environment variables
 * using zod schemas grouped by service, then checks live reachability of
 * external dependencies and validates that the multi-network Stellar
 * configuration is internally consistent.
 *
 * Call validateEnvVars() first (fail-fast on missing/malformed vars), then
 * runStartupValidation() after validateEnv() and before app.listen().
 *
 * Validation rules:
 *  1. All required vars must be present and non-empty.
 *  2. TWILIO_ACCOUNT_SID must start with "AC".
 *  3. STELLAR_NETWORK_PASSPHRASE must match the canonical passphrase for the
 *     configured STELLAR_NETWORK (testnet / mainnet).
 *  4. STELLAR_HORIZON_URL and STELLAR_SOROBAN_RPC_URL must not point at the
 *     opposite network's well-known hostnames.
 *  5. FACTORY_CONTRACT_ID must be set when STELLAR_NETWORK is "mainnet".
 */
import { z } from 'zod';
import { BackendEnv } from './env';
import { outboundFetch } from '../lib/outboundHttpClient';

// ---------------------------------------------------------------------------
// Internal probe helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Zod schemas grouped by service
// ---------------------------------------------------------------------------

const nonEmptyString = z.string().min(1, 'must be a non-empty string');

/**
 * Required vars: missing any of these triggers process.exit(1).
 * Optional vars: absence produces a warning but execution continues.
 */
const REQUIRED_SCHEMAS = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  Auth: z.object({
    JWT_SECRET: nonEmptyString.describe('JWT signing secret'),
    ADMIN_JWT_SECRET: nonEmptyString.describe('Admin JWT signing secret'),
  }),

  // ── Stellar ───────────────────────────────────────────────────────────────
  Stellar: z.object({
    STELLAR_NETWORK: z
      .enum(['testnet', 'mainnet'])
      .describe('Stellar network identifier'),
    STELLAR_HORIZON_URL: nonEmptyString
      .url('must be a valid URL')
      .describe('Stellar Horizon API URL'),
    STELLAR_SOROBAN_RPC_URL: nonEmptyString
      .url('must be a valid URL')
      .describe('Stellar Soroban RPC URL'),
    STELLAR_NETWORK_PASSPHRASE: nonEmptyString.describe(
      'Stellar network passphrase'
    ),
    DATABASE_URL: nonEmptyString
      .url('must be a valid URL')
      .describe('PostgreSQL connection URL'),
  }),

  // ── IPFS / Pinata ─────────────────────────────────────────────────────────
  IPFS: z.object({
    PINATA_API_KEY: nonEmptyString.describe('Pinata IPFS API key'),
    PINATA_API_SECRET: nonEmptyString.describe('Pinata IPFS API secret'),
  }),

  // ── Notifications ─────────────────────────────────────────────────────────
  Notifications: z.object({
    SENDGRID_API_KEY: nonEmptyString.describe('SendGrid email API key'),
    TWILIO_ACCOUNT_SID: nonEmptyString
      .regex(/^AC/, 'must start with "AC"')
      .describe('Twilio account SID (must start with AC)'),
    TWILIO_AUTH_TOKEN: nonEmptyString.describe('Twilio auth token'),
    TWILIO_PHONE_NUMBER: nonEmptyString.describe('Twilio sender phone number'),
  }),
} as const;

const OPTIONAL_VARS: Record<string, { service: string; description: string }> = {
  REDIS_URL: { service: 'Cache', description: 'Redis connection URL (defaults to localhost)' },
  SENTRY_DSN: { service: 'Observability', description: 'Sentry DSN for error tracking' },
  FACTORY_CONTRACT_ID: { service: 'Stellar', description: 'Soroban factory contract ID (required on mainnet)' },
  PINATA_API_KEY_NEXT: { service: 'IPFS', description: 'Pinata API key for key rotation' },
  PINATA_API_SECRET_NEXT: { service: 'IPFS', description: 'Pinata API secret for key rotation' },
  VAULT_ROLE_ID: { service: 'Vault', description: 'HashiCorp Vault AppRole role ID' },
  VAULT_SECRET_ID: { service: 'Vault', description: 'HashiCorp Vault AppRole secret ID' },
  VAULT_ADDR: { service: 'Vault', description: 'HashiCorp Vault server address' },
  OTEL_EXPORTER_OTLP_ENDPOINT: { service: 'Observability', description: 'OpenTelemetry collector endpoint' },
};

// ---------------------------------------------------------------------------
// Env-var validation with grouped output
// ---------------------------------------------------------------------------

interface ValidationFailure {
  service: string;
  variable: string;
  message: string;
}

interface ValidationWarning {
  service: string;
  variable: string;
  description: string;
}

/**
 * Validate all required environment variables using zod schemas.
 * On failure: prints a human-readable grouped report of ALL missing/malformed
 * vars and calls process.exit(1).
 * On optional var absence: logs a warning but continues.
 */
export function validateEnvVars(env: NodeJS.ProcessEnv = process.env): void {
  const failures: ValidationFailure[] = [];
  const warnings: ValidationWarning[] = [];

  // Validate required var groups
  for (const [service, schema] of Object.entries(REQUIRED_SCHEMAS)) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    for (const [varName, fieldSchema] of Object.entries(shape)) {
      const result = (fieldSchema as z.ZodTypeAny).safeParse(env[varName] ?? undefined);
      if (!result.success) {
        const issue = result.error.issues[0];
        const message = env[varName] === undefined || env[varName] === ''
          ? 'is required but not set'
          : `has invalid value: ${issue.message}`;
        failures.push({ service, variable: varName, message });
      }
    }
  }

  // Check optional vars
  for (const [varName, meta] of Object.entries(OPTIONAL_VARS)) {
    if (!env[varName]) {
      warnings.push({ service: meta.service, variable: varName, description: meta.description });
    }
  }

  // Emit warnings for optional missing vars
  if (warnings.length > 0) {
    const byService: Record<string, ValidationWarning[]> = {};
    for (const w of warnings) {
      (byService[w.service] ??= []).push(w);
    }
    console.warn('\n⚠️  Optional environment variables not set:');
    for (const [service, vars] of Object.entries(byService)) {
      console.warn(`  [${service}]`);
      for (const v of vars) {
        console.warn(`    • ${v.variable}: ${v.description}`);
      }
    }
    console.warn('');
  }

  // Fail fast if any required vars are missing or malformed
  if (failures.length > 0) {
    const byService: Record<string, ValidationFailure[]> = {};
    for (const f of failures) {
      (byService[f.service] ??= []).push(f);
    }

    const lines: string[] = [
      '',
      '❌ Startup failed — missing or invalid environment variables:',
      '',
    ];
    for (const [service, vars] of Object.entries(byService)) {
      lines.push(`  [${service}]`);
      for (const v of vars) {
        lines.push(`    • ${v.variable}: ${v.message}`);
      }
    }
    lines.push('');
    lines.push(
      'Set the missing variables in your .env file or deployment environment and restart.'
    );
    lines.push('');

    console.error(lines.join('\n'));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Live reachability checks (unchanged from original)
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
}

async function probe(name: string, fn: () => Promise<void>): Promise<CheckResult> {
  try {
    await fn();
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkDatabase(url: string): Promise<void> {
  // Validate URL format — actual connection is verified by Prisma on first query.
  // A malformed URL should fail fast here.
  const parsed = new URL(url);
  if (
    !parsed.protocol.startsWith('postgres') &&
    !parsed.protocol.startsWith('mysql') &&
    !parsed.protocol.startsWith('sqlite')
  ) {
    throw new Error(`Unsupported database protocol: ${parsed.protocol}`);
  }
}

interface NetworkReport {
  horizon: { reachable: boolean; latencyMs: number | null; passphraseMatches: boolean };
  rpc: { reachable: boolean };
  ipfs: { reachable: boolean };
}

/**
 * Probe Horizon, Soroban RPC, and the IPFS gateway for reachability.
 * Never throws — unreachable dependencies are reflected in the report so
 * callers (both `runStartupValidation` and the admin network-validate route)
 * can decide how to react.
 */
export async function runNetworkValidation(env: BackendEnv): Promise<NetworkReport> {
  const horizonStart = Date.now();
  let horizonReachable = false;
  let horizonPassphraseMatches = false;
  let horizonLatencyMs: number | null = null;
  try {
    const res = await outboundFetch(env.STELLAR_HORIZON_URL);
    horizonLatencyMs = Date.now() - horizonStart;
    if (res.ok) {
      horizonReachable = true;
      const body = await res.json().catch(() => null) as { network_passphrase?: string } | null;
      horizonPassphraseMatches = body?.network_passphrase === env.STELLAR_NETWORK_PASSPHRASE;
    }
  } catch {
    // Leave horizonReachable = false.
  }

  let rpcReachable = false;
  try {
    const res = await outboundFetch(env.STELLAR_SOROBAN_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    });
    rpcReachable = res.ok;
  } catch {
    // Leave rpcReachable = false.
  }

  let ipfsReachable = false;
  try {
    const gateway = process.env.PINATA_GATEWAY_URL ?? 'https://gateway.pinata.cloud/ipfs';
    const res = await outboundFetch(gateway, { method: 'HEAD' });
    // Gateways commonly reject a bare root path without a CID (4xx) — any
    // response short of a server error means the host itself is reachable.
    ipfsReachable = res.status < 500;
  } catch {
    // Leave ipfsReachable = false.
  }

  return {
    horizon: {
      reachable: horizonReachable,
      latencyMs: horizonLatencyMs,
      passphraseMatches: horizonPassphraseMatches,
    },
    rpc: { reachable: rpcReachable },
    ipfs: { reachable: ipfsReachable },
  };
}

// ---------------------------------------------------------------------------
// Multi-network Stellar configuration validation
// ---------------------------------------------------------------------------

const NETWORK_CANONICAL: Record<
  string,
  { passphrase: string; horizonHost: string; sorobanHost: string }
> = {
  testnet: {
    passphrase: 'Test SDF Network ; September 2015',
    horizonHost: 'horizon-testnet.stellar.org',
    sorobanHost: 'soroban-testnet.stellar.org',
  },
  mainnet: {
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonHost: 'horizon.stellar.org',
    sorobanHost: 'soroban-mainnet.stellar.org',
  },
};

/**
 * Validate that the Stellar network passphrase, RPC URLs, and contract address
 * are mutually consistent. Throws with a descriptive message on mismatch.
 */
export function validateNetworkConfig(env: BackendEnv): void {
  const network = env.STELLAR_NETWORK;
  const canonical = NETWORK_CANONICAL[network];

  if (!canonical) {
    throw new Error(
      `Unknown STELLAR_NETWORK value: "${network}". Must be "testnet" or "mainnet".`
    );
  }

  // 1. Passphrase must match the canonical value for the network
  if (env.STELLAR_NETWORK_PASSPHRASE !== canonical.passphrase) {
    throw new Error(
      `Network passphrase mismatch for "${network}".\n` +
        `  Expected : "${canonical.passphrase}"\n` +
        `  Configured: "${env.STELLAR_NETWORK_PASSPHRASE}"\n` +
        `Ensure STELLAR_NETWORK_PASSPHRASE matches STELLAR_NETWORK.`
    );
  }

  // 2. Horizon URL must not point at the opposite network
  const oppositeNetwork = network === 'testnet' ? 'mainnet' : 'testnet';
  const opposite = NETWORK_CANONICAL[oppositeNetwork];

  if (env.STELLAR_HORIZON_URL.includes(opposite.horizonHost)) {
    throw new Error(
      `STELLAR_HORIZON_URL points at ${oppositeNetwork} ("${env.STELLAR_HORIZON_URL}") ` +
        `but STELLAR_NETWORK is "${network}". Fix the URL or the network setting.`
    );
  }

  if (env.STELLAR_SOROBAN_RPC_URL.includes(opposite.sorobanHost)) {
    throw new Error(
      `STELLAR_SOROBAN_RPC_URL points at ${oppositeNetwork} ("${env.STELLAR_SOROBAN_RPC_URL}") ` +
        `but STELLAR_NETWORK is "${network}". Fix the URL or the network setting.`
    );
  }

  // 3. Contract address must be set on mainnet
  if (network === 'mainnet' && !env.FACTORY_CONTRACT_ID) {
    throw new Error(
      'FACTORY_CONTRACT_ID must be set when STELLAR_NETWORK is "mainnet".'
    );
  }
}

export async function runStartupValidation(env: BackendEnv): Promise<void> {
  const isProduction = env.NODE_ENV === 'production';

  // Fail fast on static config mismatch — always, regardless of environment
  validateNetworkConfig(env);

  // Run live reachability checks in parallel
  const [networkReport, dbCheck] = await Promise.all([
    runNetworkValidation(env),
    probe('Database URL', () => checkDatabase(env.DATABASE_URL)),
  ]);

  const networkOk =
    networkReport.horizon.reachable &&
    networkReport.rpc.reachable &&
    networkReport.ipfs.reachable;
  const allOk = networkOk && dbCheck.ok;

  if (allOk) {
    console.log('✅ Startup validation passed. Network report:', JSON.stringify(networkReport));
    return;
  }

  const failures: CheckResult[] = [];
  if (!networkReport.horizon.reachable) {
    failures.push({ name: 'Horizon', ok: false, error: 'unreachable' });
  }
  if (!networkReport.rpc.reachable) {
    failures.push({ name: 'Soroban RPC', ok: false, error: 'unreachable' });
  }
  if (!networkReport.ipfs.reachable) {
    failures.push({ name: 'IPFS gateway', ok: false, error: 'unreachable' });
  }
  if (!dbCheck.ok) {
    failures.push(dbCheck);
  }

  const report = failures.map((c) => `  • ${c.name}: ${c.error}`).join('\n');

  const message = `Startup validation failed:\n${report}`;

  if (isProduction) {
    throw new Error(message);
  } else {
    console.warn(`⚠️  ${message}`);
  }
}
