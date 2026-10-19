import { ENV } from './env';

const NETWORK_CONFIGS = {
  testnet: {
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    explorerBaseUrl: 'https://stellar.expert/explorer/testnet',
  },
  mainnet: {
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
    explorerBaseUrl: 'https://stellar.expert/explorer/public',
  },
} as const;

/**
 * Soroban contract IDs are 56-character base32 strings starting with 'C'.
 * Testnet contract IDs are distinct from mainnet ones — a contract deployed
 * on testnet cannot be used on mainnet and vice versa.
 */
const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Validates a Soroban contract ID format.
 * Throws with the variable name so misconfiguration is immediately actionable.
 */
export function validateContractId(id: string, variableName: string): void {
  if (!id) {
    throw new Error(
      `${variableName} is empty. Set it to the deployed contract address for VITE_NETWORK="${ENV.NETWORK}".`,
    );
  }
  if (!CONTRACT_ID_REGEX.test(id)) {
    throw new Error(
      `${variableName} is malformed: "${id}". ` +
        `Expected a 56-character Soroban contract ID starting with "C" (e.g. CABC...XYZ). ` +
        `Check that you copied the correct address for VITE_NETWORK="${ENV.NETWORK}".`,
    );
  }
}

export const STELLAR_CONFIG = {
  network: ENV.NETWORK,
  factoryContractId: ENV.FACTORY_CONTRACT_ID,
  ...NETWORK_CONFIGS[ENV.NETWORK],
} as const;

/** Identifier for a supported Stellar wallet adapter. */
export type WalletId = 'freighter' | 'albedo' | 'xbull' | 'lobstr';

export interface WalletAdapterConfig {
  /** Stable identifier used by the wallet kit / adapter layer. */
  id: WalletId;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Icon asset path (relative to the public directory) for the UI entry. */
  icon: string;
  /** Short description shown alongside the wallet entry. */
  description: string;
  /** Whether the wallet is available as a browser extension. */
  isExtension: boolean;
}

/**
 * Single source of truth for the wallets surfaced in the UI.
 * The wallet adapter layer resolves these ids via the Stellar wallet kit.
 */
export const WALLET_ADAPTERS: readonly WalletAdapterConfig[] = [
  {
    id: 'freighter',
    name: 'Freighter',
    icon: '/wallets/freighter.svg',
    description: 'Browser extension wallet by Stellar Development Foundation.',
    isExtension: true,
  },
  {
    id: 'albedo',
    name: 'Albedo',
    icon: '/wallets/albedo.svg',
    description: 'Web-based wallet that requires no installation.',
    isExtension: false,
  },
  {
    id: 'xbull',
    name: 'xBull',
    icon: '/wallets/xbull.svg',
    description: 'Browser extension and mobile wallet with multi-account support.',
    isExtension: true,
  },
  {
    id: 'lobstr',
    name: 'Lobstr',
    icon: '/wallets/lobstr.svg',
    description: 'Popular Stellar wallet available as extension and mobile app.',
    isExtension: true,
  },
] as const;

/** Returns the wallet adapter config for the given id, if supported. */
export const getWalletAdapter = (id: WalletId): WalletAdapterConfig | undefined =>
  WALLET_ADAPTERS.find((wallet) => wallet.id === id);

/** The active network as a plain string — useful for runtime mismatch checks. */
export const ACTIVE_NETWORK: 'testnet' | 'mainnet' = ENV.NETWORK;

/**
 * Returns the network config for the active network.
 * The optional `_network` parameter is accepted for backwards compatibility
 * but ignored — the active network is always determined by VITE_NETWORK.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const getNetworkConfig = (_network?: 'testnet' | 'mainnet') => NETWORK_CONFIGS[ENV.NETWORK];
