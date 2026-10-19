type Network = 'testnet' | 'mainnet';
export type ExplorerLinkType = 'tx' | 'contract' | 'account';
export type ExplorerProvider = 'stellar.expert' | 'stellarchain';

/**
 * Centralized explorer configuration.
 *
 * Each provider defines a base URL per network. Path builders below are shared
 * across providers so that adding a new provider only requires extending the
 * `EXPLORER_CONFIG` map.
 */
const EXPLORER_CONFIG: Record<ExplorerProvider, Record<Network, string>> = {
  'stellar.expert': {
    testnet: 'https://stellar.expert/explorer/testnet',
    mainnet: 'https://stellar.expert/explorer/public',
  },
  stellarchain: {
    testnet: 'https://testnet.stellarchain.io',
    mainnet: 'https://stellarchain.io',
  },
};

const DEFAULT_PROVIDER: ExplorerProvider = 'stellar.expert';

/**
 * Resolve the default explorer provider from the environment, falling back to
 * `stellar.expert` when unset or invalid.
 */
function resolveDefaultProvider(): ExplorerProvider {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const configured = env?.VITE_EXPLORER_PROVIDER;
    if (configured && configured in EXPLORER_CONFIG) {
      return configured as ExplorerProvider;
    }
  } catch {
    // `import.meta.env` may be unavailable in some test environments.
  }
  return DEFAULT_PROVIDER;
}

/**
 * Return the base URL for a given provider and network.
 */
export function getExplorerBaseUrl(
  network: Network,
  provider: ExplorerProvider = resolveDefaultProvider(),
): string {
  const config = EXPLORER_CONFIG[provider] ?? EXPLORER_CONFIG[DEFAULT_PROVIDER];
  return config[network];
}

/**
 * Build the path segment for a given link type and identifier.
 */
function buildPath(type: ExplorerLinkType, id: string): string {
  return `${type}/${id}`;
}

export function getExplorerUrl(
  type: ExplorerLinkType,
  id: string,
  network: Network,
  provider: ExplorerProvider = resolveDefaultProvider(),
): string {
  return `${getExplorerBaseUrl(network, provider)}/${buildPath(type, id)}`;
}

export function getTxUrl(
  txHash: string,
  network: Network,
  provider: ExplorerProvider = resolveDefaultProvider(),
): string {
  return getExplorerUrl('tx', txHash, network, provider);
}

export function getContractUrl(
  contractId: string,
  network: Network,
  provider: ExplorerProvider = resolveDefaultProvider(),
): string {
  return getExplorerUrl('contract', contractId, network, provider);
}

export function getAccountUrl(
  accountId: string,
  network: Network,
  provider: ExplorerProvider = resolveDefaultProvider(),
): string {
  return getExplorerUrl('account', accountId, network, provider);
}

/**
 * Infer the explorer link type from the shape of an identifier:
 * G… / M… (StrKey accounts), C… (contracts) or a 64-char hex tx hash.
 * Returns null when the value is none of these, so callers can skip the link.
 */
export function detectExplorerLinkType(id: string): ExplorerLinkType | null {
  if (/^[GM][A-Z2-7]{55,68}$/.test(id)) return 'account';
  if (/^C[A-Z2-7]{55}$/.test(id)) return 'contract';
  if (/^[0-9a-fA-F]{64}$/.test(id)) return 'tx';
  return null;
}