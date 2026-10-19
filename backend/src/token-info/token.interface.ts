export type ExplorerProvider = 'stellar.expert' | 'stellarchain';

export interface TokenBasicInfo {
  name: string;
  symbol: string;
  decimals: number;
  address: string;
  explorerUrl?: string;
  explorerProvider?: ExplorerProvider;
}

export interface TokenSupplyInfo {
  total: string;
  initial: string;
  circulating: string;
}

export interface TokenBurnInfo {
  totalBurned: string;
  burnCount: number;
  percentBurned: string;
}

export interface TokenMetadata {
  image?: string;
  description?: string;
  externalUrl?: string;
  attributes?: Record<string, unknown>[];
}

export interface TokenCreator {
  address: string;
  createdAt: string;
}

export interface TokenAnalytics {
  volume24h: string;
  volume7d: string;
  priceChange24h?: string;
  txCount24h?: number;
}

export interface Token {
  basicInfo: TokenBasicInfo;
  supplyInfo: TokenSupplyInfo;
  burnInfo: TokenBurnInfo;
  metadata?: TokenMetadata;
  creator: TokenCreator;
  analytics: TokenAnalytics;
}

export interface TokenApiResponse {
  success: boolean;
  data?: Token;
  error?: string;
  cached: boolean;
  timestamp: string;
}

export interface StellarTokenData {
  asset_code: string;
  asset_issuer: string;
  num_accounts: number;
  amount: string;
  claimable_balances_amount: string;
  liquidity_pools_amount: string;
  contracts_amount: string;
  archived_contracts_amount: string;
  balances: {
    authorized: string;
    authorized_to_maintain_liabilities: string;
    unauthorized: string;
  };
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
    auth_clawback_enabled: boolean;
  };
  paging_token: string;
}

export interface StellarLedgerData {
  created_at: string;
  transaction_hash: string;
}
