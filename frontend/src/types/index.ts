export interface TokenDeployParams {
    name: string;
    symbol: string;
    decimals: number;
    initialSupply: string;
    adminWallet: string;
    metadata?: {
        image: File;
        description: string;
    };
    metadataUri?: string;
}

export interface DeploymentResult {
    tokenAddress: string;
    transactionHash: string;
    totalFee: string;
    timestamp: number;
    metadataUrl?: string;
}

export type WalletType = 'freighter' | 'lobstr' | 'albedo' | 'xbull';

export interface WalletState {
    connected: boolean;
    address: string | null;
    network: 'testnet' | 'mainnet';
    walletType?: WalletType;
}

export interface TokenInfo {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    creator: string;
    metadataUri?: string;
    /** Current metadata version. 0 = never set; increments with each update_metadata call. */
    metadataVersion?: number;
    deployedAt: number;
    transactionHash: string;
}

/** A single historical metadata record returned by get_metadata_history. */
export interface MetadataRecord {
    uri: string;
    updatedAt: number;
    updatedBy: string;
}

export interface TokenMetadata {
    name: string;
    description: string;
    image: string;
}

export interface TransactionDetails {
    hash: string;
    status: 'pending' | 'success' | 'failed';
    timestamp: number;
    fee: string;
}

export interface FeeBreakdown {
    baseFee: number;
    metadataFee: number;
    totalFee: number;
}

export type DeploymentStatus = 'idle' | 'uploading' | 'deploying' | 'success' | 'error';

export interface AppError {
    code: string;
    message: string;
    details?: string;
}

export const ErrorCode = {
    WALLET_NOT_CONNECTED: 'WALLET_NOT_CONNECTED',
    INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
    INVALID_INPUT: 'INVALID_INPUT',
    IPFS_UPLOAD_FAILED: 'IPFS_UPLOAD_FAILED',
    TRANSACTION_FAILED: 'TRANSACTION_FAILED',
    WALLET_REJECTED: 'WALLET_REJECTED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    SIMULATION_FAILED: 'SIMULATION_FAILED',
    CONTRACT_ERROR: 'CONTRACT_ERROR',
    TIMEOUT_ERROR: 'TIMEOUT_ERROR',
    ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
    INVALID_SIGNATURE: 'INVALID_SIGNATURE',
    BURN_FAILED: 'BURN_FAILED',
    INVALID_AMOUNT: 'INVALID_AMOUNT',
    UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// Deployment Recovery Types
export type DeploymentStatusType = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface DeploymentStatusResponse {
  txHash: string;
  status: DeploymentStatusType;
  ledger?: number;
  reason?: string; // Stellar error code/reason if failed
}

// Progressive confirmation step types
export type ConfirmationStep = 'submitted' | 'pending' | 'confirming' | 'finalized';

export interface ConfirmationStepResponse {
  txHash: string;
  step: ConfirmationStep;
  confirmations?: number;
  totalConfirmations: number;
  ledger?: number;
  reason?: string;
}

// Burn Types
export interface BurnTokenParams {
    tokenAddress: string;
    from: string;
    amount: string;
}

export interface BurnResult {
    txHash: string;
    burnedAmount: string;
    newBalance: string;
    newSupply: string;
}

export interface BurnRecord {
    id: string;
    timestamp: number;
    from: string;
    amount: string;
    isAdminBurn: boolean;
    txHash: string;
    blockNumber?: number;
}

// Burn Statistics Types
export interface BurnStats {
    totalBurned: string;
    burnCount: number;
    initialSupply: string;
    currentSupply: string;
    percentBurned: number;
}

export interface BurnHistoryFilter {
    startDate?: Date;
    endDate?: Date;
    type?: 'all' | 'admin' | 'self';
    sortBy?: 'timestamp' | 'amount';
    sortOrder?: 'asc' | 'desc';
}

export interface BurnChartData {
    labels: string[];
    values: number[];
    cumulative: number[];
}

// Recurring Payment Types
export type RecurringPaymentStatus = 'active' | 'due' | 'paused' | 'cancelled';

export type PaymentInterval = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface RecurringPayment {
    id: string;
    recipient: string;
    amount: string;
    tokenAddress: string;
    tokenSymbol?: string;
    tokenDecimals?: number;
    memo?: string;
    interval: PaymentInterval;
    intervalSeconds: number;
    nextPaymentTime: number;
    lastPaymentTime?: number;
    paymentCount: number;
    totalPaid: string;
    status: RecurringPaymentStatus;
    createdAt: number;
    creator: string;
}

export interface RecurringPaymentHistory {
    id: string;
    paymentId: string;
    transactionHash: string;
    amount: string;
    timestamp: number;
    status: 'success' | 'failed';
}

export interface CreateRecurringPaymentParams {
    recipient: string;
    amount: string;
    tokenAddress: string;
    memo?: string;
    interval: PaymentInterval;
    customIntervalSeconds?: number;
}

export interface RecurringPaymentFilters {
    status?: RecurringPaymentStatus;
    tokenAddress?: string;
    search?: string;
}

export interface VaultProjection {
    streamId: number;
    creator: string;
    recipient: string;
    amount: string;
    status: string;
    createdAt: string | number | Date;
    /** Ledger at which vesting starts (on-chain field). */
    startLedger?: number;
    /** Ledger at which vesting fully matures (on-chain field). */
    endLedger?: number;
    claimedAt?: string | number | Date | null;
    cancelledAt?: string | number | Date | null;
    txHash?: string;
}

export * from './governance';
export * from './streams';
