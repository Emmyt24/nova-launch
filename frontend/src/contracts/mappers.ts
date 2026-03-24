/**
 * SCVal mappers: convert typed JS params → nativeToScVal calls.
 * Import these in stellar.service.ts instead of inlining nativeToScVal.
 */
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type {
  CreateTokensParams,
  SetTokenMetadataParams,
  BurnParams,
  AdminBurnParams,
  MintParams,
  CreateBuybackCampaignParams,
  UpdateGovernanceConfigParams,
  InitializeParams,
} from './factoryAbi';

/** address string → ScVal */
const addr = (a: string) => nativeToScVal(a, { type: 'address' });
/** u32 → ScVal */
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
/** u64 → ScVal */
const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
/** i128 → ScVal */
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
/** string → ScVal */
const str = (s: string) => nativeToScVal(s, { type: 'string' });
/** bool → ScVal */
const bool = (b: boolean) => nativeToScVal(b, { type: 'bool' });
/** Option<T> → ScVal (void when undefined) */
const opt = (v: xdr.ScVal | undefined): xdr.ScVal =>
  v ?? xdr.ScVal.scvVoid();

export const mappers = {
  initialize: (p: InitializeParams): xdr.ScVal[] => [
    addr(p.admin),
    addr(p.treasury),
    i128(p.base_fee),
    i128(p.metadata_fee),
  ],

  /** set_metadata(creator, tokens, total_fee_payment) */
  createTokens: (p: CreateTokensParams): xdr.ScVal[] => [
    addr(p.creator),
    nativeToScVal(
      p.tokens.map((t) => ({
        name: t.name,
        symbol: t.symbol,
        decimals: t.decimals,
        initial_supply: t.initial_supply,
        ...(t.metadata_uri !== undefined ? { metadata_uri: t.metadata_uri } : {}),
      }))
    ),
    i128(p.total_fee_payment),
  ],

  /** set_token_metadata(admin, token_index, metadata_uri) */
  setTokenMetadata: (p: SetTokenMetadataParams): xdr.ScVal[] => [
    addr(p.admin),
    u32(p.token_index),
    str(p.metadata_uri),
  ],

  /** burn(caller, token_index, amount) */
  burn: (p: BurnParams): xdr.ScVal[] => [
    addr(p.caller),
    u32(p.token_index),
    i128(p.amount),
  ],

  /** admin_burn(admin, token_index, holder, amount) */
  adminBurn: (p: AdminBurnParams): xdr.ScVal[] => [
    addr(p.admin),
    u32(p.token_index),
    addr(p.holder),
    i128(p.amount),
  ],

  /** mint(creator, token_index, to, amount) */
  mint: (p: MintParams): xdr.ScVal[] => [
    addr(p.creator),
    u32(p.token_index),
    addr(p.to),
    i128(p.amount),
  ],

  /** create_buyback_campaign(creator, token_index, budget, start_time, end_time,
   *                          min_interval, max_slippage_bps, source_token, target_token) */
  createBuybackCampaign: (p: CreateBuybackCampaignParams): xdr.ScVal[] => [
    addr(p.creator),
    u32(p.token_index),
    i128(p.budget),
    u64(p.start_time),
    u64(p.end_time),
    u64(p.min_interval),
    u32(p.max_slippage_bps),
    addr(p.source_token),
    addr(p.target_token),
  ],

  /** get_buyback_campaign(campaign_id) */
  getBuybackCampaign: (campaignId: bigint): xdr.ScVal[] => [u64(campaignId)],

  /** update_governance_config(admin, quorum_percent, approval_percent) */
  updateGovernanceConfig: (p: UpdateGovernanceConfigParams): xdr.ScVal[] => [
    addr(p.admin),
    opt(p.quorum_percent !== undefined ? u32(p.quorum_percent) : undefined),
    opt(p.approval_percent !== undefined ? u32(p.approval_percent) : undefined),
  ],

  /** is_paused() — no args */
  isPaused: (): xdr.ScVal[] => [],

  /** get_state() — no args */
  getState: (): xdr.ScVal[] => [],

  /** get_token_info(index) */
  getTokenInfo: (index: number): xdr.ScVal[] => [u32(index)],

  /** get_token_info_by_address(token_address) */
  getTokenInfoByAddress: (tokenAddress: string): xdr.ScVal[] => [addr(tokenAddress)],

  /** burn(caller, token_index, amount) — alias used in service */
  burnTokens: (caller: string, tokenIndex: number, amount: bigint): xdr.ScVal[] =>
    mappers.burn({ caller, token_index: tokenIndex, amount }),
};
