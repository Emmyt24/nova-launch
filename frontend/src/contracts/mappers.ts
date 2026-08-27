/**
 * SCVal mappers: convert typed JS params → nativeToScVal calls.
 * Import these in stellar.service.ts instead of inlining nativeToScVal.
 */
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type {
  CreateTokensParams,
  SetTokenMetadataParams,
  UpdateMetadataParams,
  GetMetadataHistoryParams,
  BurnParams,
  AdminBurnParams,
  MintParams,
  UpdateGovernanceConfigParams,
  InitializeParams,
  CreateProposalParams,
  VoteProposalParams,
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
/** bytes → ScVal */
const bytes = (b: Buffer | Uint8Array) => nativeToScVal(b, { type: 'bytes' });
/** enum (u32) → ScVal */
const enumVal = (v: number) => nativeToScVal(v, { type: 'u32' });
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

  /** update_metadata(admin, token_index, new_metadata_uri) */
  updateMetadata: (p: UpdateMetadataParams): xdr.ScVal[] => [
    addr(p.admin),
    u32(p.token_index),
    str(p.new_metadata_uri),
  ],

  /** get_metadata_history(token_index, version) */
  getMetadataHistory: (p: GetMetadataHistoryParams): xdr.ScVal[] => [
    u32(p.token_index),
    u32(p.version),
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

  /** update_governance_config(admin, quorum_percent, approval_percent) */
  updateGovernanceConfig: (p: UpdateGovernanceConfigParams): xdr.ScVal[] => [
    addr(p.admin),
    opt(p.quorum_percent !== undefined ? u32(p.quorum_percent) : undefined),
    opt(p.approval_percent !== undefined ? u32(p.approval_percent) : undefined),
  ],

  /** create_proposal(proposer, action_type, payload, start_time, end_time, eta) */
  createProposal: (p: CreateProposalParams): xdr.ScVal[] => [
    addr(p.proposer),
    enumVal(p.action_type),
    bytes(p.payload),
    u64(p.start_time),
    u64(p.end_time),
    u64(p.eta),
  ],

  /** vote_proposal(voter, proposal_id, support) */
  voteProposal: (p: VoteProposalParams): xdr.ScVal[] => [
    addr(p.voter),
    u64(p.proposal_id),
    enumVal(p.support),
  ],

  /** proposal_id: u64 methods */
  proposalId: (proposalId: bigint): xdr.ScVal[] => [u64(proposalId)],

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
