/**
 * Typed registry of every Token Factory contract method exposed on-chain.
 * Method names here are the single source of truth — stellar.service.ts
 * imports from this file instead of using inline strings.
 *
 * Keep this file in sync with contracts/token-factory/src/lib.rs.
 * The ABI drift regression tests in __tests__/factoryAbi.test.ts verify
 * that every entry here matches an exported function name.
 */

// ---------------------------------------------------------------------------
// Method name constants
// ---------------------------------------------------------------------------

export const FACTORY_METHODS = {
  // Lifecycle
  initialize: 'initialize',
  get_state: 'get_state',
  is_paused: 'is_paused',
  pause: 'pause',
  unpause: 'unpause',

  // Admin
  transfer_admin: 'transfer_admin',
  propose_admin: 'propose_admin',
  accept_admin: 'accept_admin',
  update_fees: 'update_fees',

  // Token creation (set_metadata is the batch-create entry point in lib.rs)
  create_tokens: 'set_metadata',
  get_token_info: 'get_token_info',
  get_token_info_by_address: 'get_token_info_by_address',
  get_tokens_by_creator: 'get_tokens_by_creator',
  get_creator_token_count: 'get_creator_token_count',

  // Token metadata
  set_token_metadata: 'set_token_metadata',

  // Token lifecycle
  pause_token: 'pause_token',
  unpause_token: 'unpause_token',
  is_token_paused: 'is_token_paused',
  get_token_stats: 'get_token_stats',

  // Mint
  mint: 'mint',
  get_remaining_mintable: 'get_remaining_mintable',

  // Burn
  burn: 'burn',
  admin_burn: 'admin_burn',
  batch_burn: 'batch_burn',
  get_burn_count: 'get_burn_count',

  // Buyback campaigns
  create_buyback_campaign: 'create_buyback_campaign',
  get_buyback_campaign: 'get_buyback_campaign',

  // Governance
  get_governance_config: 'get_governance_config',
  update_governance_config: 'update_governance_config',
  is_quorum_met: 'is_quorum_met',
  is_approval_met: 'is_approval_met',

  // Timelock
  schedule_fee_update: 'schedule_fee_update',
  execute_change: 'execute_change',
  cancel_change: 'cancel_change',
  get_pending_change: 'get_pending_change',
  get_timelock_config: 'get_timelock_config',

  // Treasury
  initialize_treasury_policy: 'initialize_treasury_policy',
  withdraw_fees: 'withdraw_fees',
  get_treasury_policy: 'get_treasury_policy',
  get_remaining_capacity: 'get_remaining_capacity',

  // Vault
  create_vault: 'create_vault',
  get_vault: 'get_vault',
  claim_vault: 'claim_vault',
  cancel_vault: 'cancel_vault',
} as const;

export type FactoryMethod = (typeof FACTORY_METHODS)[keyof typeof FACTORY_METHODS];

// ---------------------------------------------------------------------------
// Parameter shapes (mirrors lib.rs argument order, excluding `env: Env`)
// ---------------------------------------------------------------------------

export interface InitializeParams {
  admin: string;       // Address
  treasury: string;    // Address
  base_fee: bigint;    // i128
  metadata_fee: bigint; // i128
}

export interface TokenCreationParam {
  name: string;
  symbol: string;
  decimals: number;    // u32
  initial_supply: bigint; // i128
  metadata_uri?: string;
}

/** Matches `set_metadata(creator, tokens, total_fee_payment)` in lib.rs */
export interface CreateTokensParams {
  creator: string;                  // Address
  tokens: TokenCreationParam[];     // Vec<TokenCreationParams>
  total_fee_payment: bigint;        // i128
}

/** Matches `set_token_metadata(admin, token_index, metadata_uri)` */
export interface SetTokenMetadataParams {
  admin: string;        // Address
  token_index: number;  // u32
  metadata_uri: string; // String
}

/** Matches `burn(caller, token_index, amount)` */
export interface BurnParams {
  caller: string;       // Address
  token_index: number;  // u32
  amount: bigint;       // i128
}

/** Matches `admin_burn(admin, token_index, holder, amount)` */
export interface AdminBurnParams {
  admin: string;        // Address
  token_index: number;  // u32
  holder: string;       // Address
  amount: bigint;       // i128
}

/** Matches `mint(creator, token_index, to, amount)` */
export interface MintParams {
  creator: string;      // Address
  token_index: number;  // u32
  to: string;           // Address
  amount: bigint;       // i128
}

/** Matches `create_buyback_campaign(creator, token_index, budget, ...)` */
export interface CreateBuybackCampaignParams {
  creator: string;           // Address
  token_index: number;       // u32
  budget: bigint;            // i128
  start_time: bigint;        // u64
  end_time: bigint;          // u64
  min_interval: bigint;      // u64
  max_slippage_bps: number;  // u32
  source_token: string;      // Address
  target_token: string;      // Address
}

/** Matches `update_governance_config(admin, quorum_percent, approval_percent)` */
export interface UpdateGovernanceConfigParams {
  admin: string;
  quorum_percent?: number;   // Option<u32>
  approval_percent?: number; // Option<u32>
}
