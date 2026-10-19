export interface TokenBasicInfo {
  name: string;
  symbol: string;
  decimals: number;
  address: string;
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

export interface TokenCreationFeeQuoteOptions {
  /** Number of metadata attributes attached to the token (affects metadata fee). */
  metadataAttributeCount?: number;
  /** Whether an image is attached to the token metadata. */
  hasImage?: boolean;
  /** Whether a description is attached to the token metadata. */
  hasDescription?: boolean;
  /** Whether an external URL is attached to the token metadata. */
  hasExternalUrl?: boolean;
  /** Optional override for the base creation fee (in stroops). */
  baseFeeOverride?: string;
}

export interface TokenCreationFeeQuote {
  /** Base creation fee in stroops. */
  baseFee: string;
  /** Metadata-related fee in stroops. */
  metadataFee: string;
  /** Total fee in stroops (baseFee + metadataFee). */
  totalFee: string;
  /** Total fee expressed in XLM. */
  totalFeeXlm: string;
  /** Currency/asset used for the fee. */
  currency: string;
  /** Timestamp of when the quote was generated. */
  timestamp: string;
}
