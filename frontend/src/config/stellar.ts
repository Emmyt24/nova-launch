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

/**
 * Returns the network config for the active network.
 * The optional `_network` parameter is accepted for backwards compatibility
 * but ignored — the active network is always determined by VITE_NETWORK.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const getNetworkConfig = (_network?: 'testnet' | 'mainnet') => NETWORK_CONFIGS[ENV.NETWORK];
