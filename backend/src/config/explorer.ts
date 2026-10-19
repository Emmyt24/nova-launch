/**
 * Centralized block explorer configuration.
 *
 * This module is the single source of truth for block explorer URLs across
 * the backend (and is mirrored/shared with the frontend). It supports multiple
 * explorer providers (stellar.expert and StellarChain) and multiple networks
 * (testnet, mainnet, futurenet).
 */

export type Network = 'testnet' | 'mainnet' | 'futurenet';

export type ExplorerProvider = 'stellar.expert' | 'stellarchain';

export type ExplorerEntityType = 'tx' | 'account' | 'contract' | 'asset';

export interface ExplorerProviderConfig {
  /** Base URL for the explorer on this network (no trailing slash). */
  baseUrl: string;
  /** Path builders for each supported entity type. */
  paths: {
    tx: (id: string) => string;
    account: (id: string) => string;
    contract: (id: string) => string;
    asset: (id: string) => string;
  };
}

export type ExplorerNetworkConfig = Record<ExplorerProvider, ExplorerProviderConfig>;

export const DEFAULT_EXPLORER_PROVIDER: ExplorerProvider = 'stellar.expert';

/**
 * Mapping of network -> provider -> configuration.
 */
export const EXPLORER_CONFIG: Record<Network, ExplorerNetworkConfig> = {
  testnet: {
    'stellar.expert': {
      baseUrl: 'https://stellar.expert/explorer/testnet',
      paths: {
        tx: (id) => `/tx/${id}`,
        account: (id) => `/account/${id}`,
        contract: (id) => `/contract/${id}`,
        asset: (id) => `/asset/${id}`,
      },
    },
    stellarchain: {
      baseUrl: 'https://testnet.stellarchain.io',
      paths: {
        tx: (id) => `/tx/${id}`,
        account: (id) => `/account/${id}`,
        contract: (id) => `/contract/${id}`,
        asset: (id) => `/asset/${id}`,
      },
    },
  },
  mainnet: {
    'stellar.expert': {
      baseUrl: 'https://stellar.expert/explorer/public',
      paths: {
        tx: (id) => `/tx/${id}`,
        account: (id) => `/account/${id}`,
        contract: (id) => `/contract/${id}`,
        asset: (id) => `/asset/${id}`,
      },
    },
    stellarchain: {
      baseUrl: 'https://stellarchain.io',
      paths: {
        tx: (id) => `/tx/${id}`,
        account: (id) => `/account/${id}`,
        contract: (id) => `/contract/${id}`,
        asset: (id) => `/asset/${id}`,
      },
    },
  },
  futurenet: {
    'stellar.expert': {
      baseUrl: 'https://stellar.expert/explorer/futurenet',
      paths: {
        tx: (id) => `/tx/${id}`,
        account: (id) => `/account/${id}`,
        contract: (id) => `/contract/${id}`,
        asset: (id) => `/asset/${id}`,
      },
    },
    stellarchain: {
      baseUrl: 'https://futurenet.stellarchain.io',
      paths: {
        tx: (id) => `/tx/${id}`,
        account: (id) => `/account/${id}`,
        contract: (id) => `/contract/${id}`,
        asset: (id) => `/asset/${id}`,
      },
    },
  },
};

/**
 * Returns the base URL for the given network and provider.
 */
export function getExplorerBaseUrl(
  network: Network,
  provider: ExplorerProvider = DEFAULT_EXPLORER_PROVIDER,
): string {
  return EXPLORER_CONFIG[network][provider].baseUrl;
}

/**
 * Returns the full explorer URL for a given entity type and identifier.
 */
export function getExplorerUrl(
  entityType: ExplorerEntityType,
  id: string,
  network: Network,
  provider: ExplorerProvider = DEFAULT_EXPLORER_PROVIDER,
): string {
  const config = EXPLORER_CONFIG[network][provider];
  return `${config.baseUrl}${config.paths[entityType](id)}`;
}

export function getTxUrl(
  id: string,
  network: Network,
  provider: ExplorerProvider = DEFAULT_EXPLORER_PROVIDER,
): string {
  return getExplorerUrl('tx', id, network, provider);
}

export function getAccountUrl(
  id: string,
  network: Network,
  provider: ExplorerProvider = DEFAULT_EXPLORER_PROVIDER,
): string {
  return getExplorerUrl('account', id, network, provider);
}

export function getContractUrl(
  id: string,
  network: Network,
  provider: ExplorerProvider = DEFAULT_EXPLORER_PROVIDER,
): string {
  return getExplorerUrl('contract', id, network, provider);
}

export function getAssetUrl(
  id: string,
  network: Network,
  provider: ExplorerProvider = DEFAULT_EXPLORER_PROVIDER,
): string {
  return getExplorerUrl('asset', id, network, provider);
}

/**
 * Detects the explorer entity type from the shape of an identifier.
 *
 * - Transaction hashes are 64 hex characters.
 * - Contract IDs are 56 characters starting with "C".
 * - Account IDs are 56 characters starting with "G".
 * - Asset identifiers are of the form "CODE:ISSUER" (or "native").
 *
 * Returns `null` when the identifier shape is not recognized.
 */
export function detectExplorerLinkType(id: string): ExplorerEntityType | null {
  if (!id) {
    return null;
  }

  const trimmed = id.trim();

  // Transaction hash: 64 hex characters.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return 'tx';
  }

  // Contract ID: 56 characters starting with "C".
  if (/^C[A-Z0-9]{55}$/.test(trimmed)) {
    return 'contract';
  }

  // Account ID: 56 characters starting with "G".
  if (/^G[A-Z0-9]{55}$/.test(trimmed)) {
    return 'account';
  }

  // Asset: "CODE:ISSUER" or "native".
  if (trimmed.toLowerCase() === 'native' || /^[A-Za-z0-9]{1,12}:G[A-Z0-9]{55}$/.test(trimmed)) {
    return 'asset';
  }

  return null;
}