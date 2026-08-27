/**
 * Types for the payment-streaming/vesting feature (Issue #1765).
 *
 * Distinct from `VaultProjection` in `types/index.ts`, which backs the
 * pre-existing Vaults feature — see `services/vaultsApi.ts` for that
 * naming-history note. `PaymentStreamOnChain` mirrors the token-factory
 * contract's `StreamInfo`; `PaymentStreamMetadata` mirrors the backend's
 * off-chain `PaymentStreamMetadata` Prisma model.
 */

export interface PaymentStreamMilestone {
  description: string;
  oracleAddress: string;
  unlockAmount: string;
  verified: boolean;
}

/** Mirrors the contract's `StreamInfo` struct (all amounts as decimal strings). */
export interface PaymentStreamOnChain {
  id: string;
  creator: string;
  recipient: string;
  tokenIndex: number;
  totalAmount: string;
  claimedAmount: string;
  startTime: number;
  endTime: number;
  cliffTime: number;
  metadata?: string | null;
  cancelled: boolean;
  paused: boolean;
  disputed: boolean;
  milestones: PaymentStreamMilestone[];
}

/** Off-chain descriptive metadata, served by `GET/PUT /api/streams/:streamId/metadata`. */
export interface PaymentStreamMetadata {
  streamId: string;
  creator: string;
  recipient: string;
  title?: string | null;
  description?: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
