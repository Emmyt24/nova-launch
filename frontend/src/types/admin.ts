/**
 * Admin and treasury state types.
 * All fields are read-only snapshots from contract simulation — no mutations here.
 */

export interface FactoryAdminState {
  /** Current admin address */
  admin: string;
  /** Proposed admin address (pending two-step transfer), null if none */
  proposedAdmin: string | null;
  /** Treasury address */
  treasury: string;
  /** Base token creation fee in stroops */
  baseFee: bigint;
  /** Metadata fee in stroops */
  metadataFee: bigint;
  /** Whether the factory contract is paused */
  paused: boolean;
}

export interface TreasuryPolicy {
  /** Daily withdrawal cap in stroops */
  dailyCap: bigint;
  /** Amount already withdrawn today in stroops */
  withdrawnToday: bigint;
  /** Remaining capacity today in stroops */
  remainingCapacity: bigint;
  /** Allowlisted recipient addresses */
  allowedRecipients: string[];
}

export interface TimelockConfig {
  /** Minimum delay in seconds before a scheduled change can execute */
  minDelay: number;
  /** Maximum delay in seconds */
  maxDelay: number;
}

export interface PendingChange {
  /** Change type identifier */
  changeType: string;
  /** Scheduled execution timestamp (Unix seconds) */
  executeAfter: number;
  /** Human-readable description of the pending change */
  description: string;
}

/** Allowlist mode for token transfers (compliance use cases) */
export interface AllowlistConfig {
  /** Whether allowlist mode is enabled for the token */
  enabled: boolean;
  /** Allowlisted addresses permitted to send/receive when enabled */
  allowedAddresses: string[];
}

/** Storage TTL extension state for persistent entries */
export interface TtlConfig {
  /** TTL bump threshold in ledgers — entries below this are extended on access */
  bumpThreshold: number;
  /** TTL extension amount in ledgers applied on bump */
  bumpAmount: number;
  /** Whether automatic TTL bump on access is enabled */
  autoBumpEnabled: boolean;
}

/** Admin action to manually bump TTL for a persistent entry */
export interface TtlBumpAction {
  /** Contract or entry key identifying the persistent entry */
  entryKey: string;
  /** Optional explicit extension amount in ledgers (defaults to configured bumpAmount) */
  extendTo?: number;
}

/** Aggregated state loaded by the admin panel */
export interface AdminPanelState {
  adminState: FactoryAdminState;
  treasuryPolicy: TreasuryPolicy | null;
  timelockConfig: TimelockConfig | null;
  pendingChange: PendingChange | null;
  allowlistConfig: AllowlistConfig | null;
  ttlConfig: TtlConfig | null;
  loadedAt: number;
}

export type AdminPanelLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; data: AdminPanelState }
  | { status: 'error'; message: string };
