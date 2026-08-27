/**
 * Stellar SDK integration
 *
 * Core operations for interacting with Stellar network including account lookups,
 * transaction submission, and RPC calls for Soroban smart contracts.
 */

import * as StellarSdk from "@stellar/stellar-sdk";

export interface StellarNetworkConfig {
  network: "testnet" | "mainnet";
  horizonUrl: string;
  sorobanRpcUrl: string;
  factoryContractId: string;
}

export const stellarConfig: StellarNetworkConfig = {
  network: (process.env.STELLAR_NETWORK as "testnet" | "mainnet") || "testnet",
  horizonUrl:
    process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
  sorobanRpcUrl:
    process.env.STELLAR_SOROBAN_RPC_URL ||
    "https://soroban-testnet.stellar.org",
  factoryContractId: process.env.FACTORY_CONTRACT_ID || "",
};

/** Get or create Horizon server instance */
export function getHorizonServer(
  config: StellarNetworkConfig = stellarConfig
): StellarSdk.Horizon.Server {
  return new StellarSdk.Horizon.Server(config.horizonUrl);
}

/** Get or create Soroban RPC server instance */
export function getSorobanServer(
  config: StellarNetworkConfig = stellarConfig
): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(config.sorobanRpcUrl, {
    timeout: 30 * 1000,
  });
}

/**
 * Fetch account information from Horizon
 *
 * @param publicKey Stellar public key (starts with G)
 * @param config Optional Stellar network configuration
 * @returns Account details including sequence number, balances, flags, etc.
 * @throws Error if account not found or network request fails
 */
export async function fetchAccountInfo(
  publicKey: string,
  config: StellarNetworkConfig = stellarConfig
): Promise<StellarSdk.Horizon.AccountResponse> {
  if (!/^G[A-Z0-9]{55}$/.test(publicKey)) {
    throw new Error(`Invalid Stellar public key: ${publicKey}`);
  }

  const horizon = getHorizonServer(config);
  return horizon.accounts().accountId(publicKey).call();
}

/**
 * Submit a signed transaction to the Stellar network via Horizon
 *
 * @param txXdr Signed transaction XDR envelope
 * @param config Optional Stellar network configuration
 * @returns Transaction result with hash and status
 * @throws Error if submission fails
 */
export async function submitTransaction(
  txXdr: string,
  config: StellarNetworkConfig = stellarConfig
): Promise<StellarSdk.Horizon.SubmitTransactionResponse> {
  if (!txXdr || typeof txXdr !== "string") {
    throw new Error("Invalid transaction XDR");
  }

  const horizon = getHorizonServer(config);
  return horizon.submitTransaction(txXdr);
}

/**
 * Get the current network passphrase for building transactions
 *
 * @param config Optional Stellar network configuration
 * @returns Network passphrase suitable for StellarSdk.TransactionBuilder
 */
export function getNetworkPassphrase(
  config: StellarNetworkConfig = stellarConfig
): string {
  switch (config.network) {
    case "mainnet":
      return StellarSdk.Networks.PUBLIC_NETWORK_PASSPHRASE;
    case "testnet":
      return StellarSdk.Networks.TESTNET_NETWORK_PASSPHRASE;
    default:
      throw new Error(`Unknown network: ${config.network}`);
  }
}

/**
 * Build a transaction on the Stellar network
 *
 * @param sourceAccount Account to submit the transaction from
 * @param config Optional Stellar network configuration
 * @returns Configured TransactionBuilder ready for operations
 */
export function createTransactionBuilder(
  sourceAccount: StellarSdk.Account,
  config: StellarNetworkConfig = stellarConfig
): StellarSdk.TransactionBuilder {
  const passphrase = getNetworkPassphrase(config);
  return new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: passphrase,
    v1: true,
  });
}

/**
 * Get current minimum transaction fee from Horizon
 *
 * @param config Optional Stellar network configuration
 * @returns Base fee in stroops
 */
export async function getCurrentBaseFee(
  config: StellarNetworkConfig = stellarConfig
): Promise<number> {
  const horizon = getHorizonServer(config);
  const server = new StellarSdk.Horizon.Server(config.horizonUrl);
  try {
    const ledger = await server.ledgers().limit(1).order("desc").call();
    const feeStats = await server.feeStats().call();
    return Math.max(
      StellarSdk.BASE_FEE,
      parseInt(feeStats.max_fee.mode as string)
    );
  } catch (error) {
    return StellarSdk.BASE_FEE;
  }
}

/**
 * Check if an address exists on the Stellar network
 *
 * @param publicKey Stellar public key
 * @param config Optional Stellar network configuration
 * @returns true if account exists, false otherwise
 */
export async function addressExists(
  publicKey: string,
  config: StellarNetworkConfig = stellarConfig
): Promise<boolean> {
  try {
    await fetchAccountInfo(publicKey, config);
    return true;
  } catch (error: any) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Get account balances for all trustlines and native asset
 *
 * @param publicKey Stellar public key
 * @param config Optional Stellar network configuration
 * @returns Array of balances with asset details
 */
export async function getAccountBalances(
  publicKey: string,
  config: StellarNetworkConfig = stellarConfig
): Promise<StellarSdk.Horizon.BalanceLineAsset[]> {
  const account = await fetchAccountInfo(publicKey, config);
  return account.balances;
}
