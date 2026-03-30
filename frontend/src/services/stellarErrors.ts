import type { AppError } from '../types';
import { ErrorCode } from '../types';

export interface StellarErrorDetails {
    code: ErrorCode;
    message: string;
    details?: string;
    retryable: boolean;
    retrySuggestion?: string;
}

export interface TransactionFailureDetails {
    resultCode?: string;
    operationResults?: string[];
    diagnosticEvents?: any[];
    rawError?: string;
    contractErrorCode?: string;
}

export interface ContractErrorMapping {
    code: ErrorCode;
    message: string;
    details: string;
    retryable: boolean;
    retrySuggestion: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Canonical contract error mapping
 * Aligned with docs/CONTRACT_ERROR_MATRIX.md
 */
export const CONTRACT_ERROR_MAP: Record<string, ContractErrorMapping> = {
    // Token Errors
    'INSUFFICIENT_FEE': {
        code: ErrorCode.INSUFFICIENT_BALANCE,
        message: 'Insufficient fee — please ensure you have enough XLM',
        details: 'Fee payment is below the required minimum',
        retryable: true,
        retrySuggestion: 'Add more XLM to your wallet and try again',
        severity: 'medium',
    },
    'UNAUTHORIZED_ACTION': {
        code: ErrorCode.UNAUTHORIZED,
        message: 'You are not authorized to perform this action',
        details: 'Caller not authorized',
        retryable: false,
        retrySuggestion: 'Ensure you are using the correct wallet address',
        severity: 'high',
    },
    'METADATA_ALREADY_SET': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Metadata has already been set for this token',
        details: 'Metadata already set',
        retryable: false,
        retrySuggestion: 'Metadata can only be set once per token',
        severity: 'medium',
    },
    'ALREADY_INITIALIZED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Contract has already been initialized',
        details: 'Factory already initialized',
        retryable: false,
        retrySuggestion: 'Contact support if you believe this is an error',
        severity: 'high',
    },
    'BURN_NOT_ENABLED': {
        code: ErrorCode.BURN_FAILED,
        message: 'Burn functionality is not enabled for this token',
        details: 'Burn not enabled',
        retryable: false,
        retrySuggestion: 'This token does not support burning',
        severity: 'medium',
    },
    'VAULT_LOCKED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Vault is still locked — unlock conditions have not been met',
        details: 'Vault unlock time or milestone not reached',
        retryable: false,
        retrySuggestion: 'Wait until the unlock time or milestone is reached',
        severity: 'medium',
    },
    'VAULT_CANCELLED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'This vault has been cancelled',
        details: 'Vault was cancelled and is immutable',
        retryable: false,
        retrySuggestion: 'Cannot interact with a cancelled vault',
        severity: 'medium',
    },
    'INVALID_VAULT_CONFIG': {
        code: ErrorCode.INVALID_INPUT,
        message: 'Invalid vault configuration',
        details: 'Vault parameters failed validation',
        retryable: false,
        retrySuggestion: 'Review vault parameters and try again',
        severity: 'medium',
    },
    'NOTHING_TO_CLAIM': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'No claimable balance remains',
        details: 'Nothing to claim from vault or stream',
        retryable: false,
        retrySuggestion: 'All available funds have already been claimed',
        severity: 'low',
    },
    'TOKEN_ALREADY_EXISTS': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'This token symbol is already in use',
        details: 'Token with symbol already deployed',
        retryable: false,
        retrySuggestion: 'Choose a different symbol for your token',
        severity: 'medium',
    },
    'INVALID_TOKEN_PARAMS': {
        code: ErrorCode.INVALID_INPUT,
        message: 'Invalid token parameters',
        details: 'Token parameters validation failed',
        retryable: false,
        retrySuggestion: 'Review token name, symbol, decimals, and supply',
        severity: 'medium',
    },
    'TOKEN_NOT_FOUND': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Token not found on network',
        details: 'Token address does not exist',
        retryable: false,
        retrySuggestion: 'Verify the token address is correct',
        severity: 'medium',
    },
    'UNAUTHORIZED_BURN': {
        code: ErrorCode.UNAUTHORIZED,
        message: 'You are not authorized to burn this token',
        details: 'Caller not authorized to perform burn',
        retryable: false,
        retrySuggestion: 'Only the token admin can perform admin burns',
        severity: 'high',
    },
    'BURN_AMOUNT_EXCEEDS_BALANCE': {
        code: ErrorCode.INVALID_AMOUNT,
        message: 'Burn amount exceeds your token balance',
        details: 'Insufficient token balance for burn',
        retryable: false,
        retrySuggestion: 'Reduce the burn amount to your available balance',
        severity: 'medium',
    },
    'ZERO_BURN_AMOUNT': {
        code: ErrorCode.INVALID_AMOUNT,
        message: 'Burn amount must be greater than zero',
        details: 'Cannot burn zero tokens',
        retryable: false,
        retrySuggestion: 'Enter a valid burn amount',
        severity: 'low',
    },
    'METADATA_TOO_LARGE': {
        code: ErrorCode.IPFS_UPLOAD_FAILED,
        message: 'Metadata file is too large',
        details: 'Metadata exceeds size limit',
        retryable: true,
        retrySuggestion: 'Use a smaller image or reduce metadata size',
        severity: 'medium',
    },
    'INVALID_METADATA_URI': {
        code: ErrorCode.INVALID_INPUT,
        message: 'Invalid metadata URI format',
        details: 'Malformed metadata URI',
        retryable: false,
        retrySuggestion: 'Ensure the IPFS URI is correctly formatted',
        severity: 'medium',
    },
    
    // Campaign Errors
    'CAMPAIGN_NOT_FOUND': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Campaign not found',
        details: 'Campaign ID does not exist',
        retryable: false,
        retrySuggestion: 'Verify the campaign ID is correct',
        severity: 'medium',
    },
    'CAMPAIGN_ALREADY_EXISTS': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'A campaign with this ID already exists',
        details: 'Campaign ID already in use',
        retryable: false,
        retrySuggestion: 'Use a different campaign ID',
        severity: 'medium',
    },
    'CAMPAIGN_NOT_ACTIVE': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'This campaign is not currently active',
        details: 'Campaign is not in active state',
        retryable: false,
        retrySuggestion: 'Wait for the campaign to become active',
        severity: 'medium',
    },
    'CAMPAIGN_ENDED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'This campaign has already ended',
        details: 'Campaign has reached end time',
        retryable: false,
        retrySuggestion: 'Cannot execute steps on ended campaigns',
        severity: 'medium',
    },
    'INSUFFICIENT_BUDGET': {
        code: ErrorCode.INSUFFICIENT_BALANCE,
        message: 'Campaign budget has been exhausted',
        details: 'No remaining budget for execution',
        retryable: false,
        retrySuggestion: 'The campaign has used all allocated funds',
        severity: 'high',
    },
    'INVALID_TIME_RANGE': {
        code: ErrorCode.INVALID_INPUT,
        message: 'Invalid campaign time range',
        details: 'Start time must be before end time',
        retryable: false,
        retrySuggestion: 'End time must be after start time',
        severity: 'medium',
    },
    'INVALID_SLIPPAGE': {
        code: ErrorCode.INVALID_INPUT,
        message: 'Slippage must be between 0% and 100%',
        details: 'Slippage outside valid range',
        retryable: false,
        retrySuggestion: 'Adjust slippage to a valid percentage',
        severity: 'medium',
    },
    'UNAUTHORIZED_CREATOR': {
        code: ErrorCode.UNAUTHORIZED,
        message: 'You are not authorized to create campaigns for this token',
        details: 'Caller not authorized',
        retryable: false,
        retrySuggestion: 'Only token admins can create campaigns',
        severity: 'high',
    },
    'MIN_INTERVAL_NOT_MET': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Minimum interval between executions not met',
        details: 'Execution attempted too soon',
        retryable: true,
        retrySuggestion: 'Wait before executing the next campaign step',
        severity: 'medium',
    },
    
    // Governance Errors
    'PROPOSAL_NOT_FOUND': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Proposal not found',
        details: 'Proposal ID does not exist',
        retryable: false,
        retrySuggestion: 'Verify the proposal ID is correct',
        severity: 'medium',
    },
    'VOTING_NOT_STARTED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Voting has not started yet',
        details: 'Voting period not started',
        retryable: false,
        retrySuggestion: 'Wait for the voting period to begin',
        severity: 'medium',
    },
    'VOTING_ENDED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Voting period has ended',
        details: 'Voting period closed',
        retryable: false,
        retrySuggestion: 'Cannot vote on closed proposals',
        severity: 'medium',
    },
    'ALREADY_VOTED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'You have already voted on this proposal',
        details: 'Voter has already cast vote',
        retryable: false,
        retrySuggestion: 'Each address can only vote once',
        severity: 'medium',
    },
    'INSUFFICIENT_VOTING_POWER': {
        code: ErrorCode.INSUFFICIENT_BALANCE,
        message: 'Insufficient voting power',
        details: 'Insufficient token balance to vote',
        retryable: false,
        retrySuggestion: 'You need tokens to vote on proposals',
        severity: 'high',
    },
    'QUORUM_NOT_MET': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Proposal did not reach minimum quorum',
        details: 'Insufficient participation',
        retryable: false,
        retrySuggestion: 'More participation needed for execution',
        severity: 'medium',
    },
    'UNAUTHORIZED_PROPOSER': {
        code: ErrorCode.UNAUTHORIZED,
        message: 'You don\'t have enough tokens to create proposals',
        details: 'Insufficient tokens to propose',
        retryable: false,
        retrySuggestion: 'Acquire more tokens to meet proposal threshold',
        severity: 'high',
    },
    
    // Vault Errors
    'VAULT_NOT_FOUND': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Vault not found',
        details: 'Vault ID does not exist',
        retryable: false,
        retrySuggestion: 'Verify the vault ID is correct',
        severity: 'medium',
    },
    'VAULT_ALREADY_CLAIMED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'This vault has already been claimed',
        details: 'Vault already claimed',
        retryable: false,
        retrySuggestion: 'Cannot claim the same vault twice',
        severity: 'medium',
    },
    'UNAUTHORIZED_CLAIMER': {
        code: ErrorCode.UNAUTHORIZED,
        message: 'You are not authorized to claim this vault',
        details: 'Caller is not recipient',
        retryable: false,
        retrySuggestion: 'Only the designated recipient can claim',
        severity: 'high',
    },
    
    // Stream Errors
    'STREAM_NOT_FOUND': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Payment stream not found',
        details: 'Stream ID does not exist',
        retryable: false,
        retrySuggestion: 'Verify the stream ID is correct',
        severity: 'medium',
    },
    'STREAM_ALREADY_CLAIMED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'This stream has already been claimed',
        details: 'Stream already claimed',
        retryable: false,
        retrySuggestion: 'Cannot claim the same stream twice',
        severity: 'medium',
    },
    'UNAUTHORIZED_STREAM_CLAIMER': {
        code: ErrorCode.UNAUTHORIZED,
        message: 'You are not authorized to claim this stream',
        details: 'Caller is not recipient',
        retryable: false,
        retrySuggestion: 'Only the designated recipient can claim',
        severity: 'high',
    },
    
    // System Errors
    'CONTRACT_PAUSED': {
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Protocol is currently paused for maintenance',
        details: 'Contract is paused',
        retryable: true,
        retrySuggestion: 'Wait for the protocol to resume operations',
        severity: 'critical',
    },
};

export class StellarError extends Error implements AppError {
    code: ErrorCode;
    details?: string;
    retryable: boolean;
    retrySuggestion?: string;
    transactionFailure?: TransactionFailureDetails;
    severity?: 'low' | 'medium' | 'high' | 'critical';

    constructor(errorDetails: StellarErrorDetails, transactionFailure?: TransactionFailureDetails) {
        super(errorDetails.message);
        this.name = 'StellarError';
        this.code = errorDetails.code;
        this.details = errorDetails.details;
        this.retryable = errorDetails.retryable;
        this.retrySuggestion = errorDetails.retrySuggestion;
        this.transactionFailure = transactionFailure;
    }
}

export interface SimulationDecodeResult {
    /** Human-readable message safe to show in the UI */
    userMessage: string;
    /** Raw detail preserved for debugging */
    debugDetail: string;
    /** Mapped ErrorCode */
    code: ErrorCode;
    retryable: boolean;
    retrySuggestion?: string;
}

/**
 * Numeric contract error codes emitted by the Soroban contract.
 * Aligned with the error table in the README / CONTRACT_ERROR_MATRIX.md.
 */
const NUMERIC_CONTRACT_ERROR_MAP: Record<number, string> = {
    1: 'INSUFFICIENT_FEE',
    2: 'UNAUTHORIZED_ACTION',
    3: 'INVALID_TOKEN_PARAMS',
    4: 'TOKEN_NOT_FOUND',
    5: 'METADATA_ALREADY_SET',
    6: 'ALREADY_INITIALIZED',
    7: 'BURN_AMOUNT_EXCEEDS_BALANCE',
    8: 'BURN_NOT_ENABLED',
    9: 'ZERO_BURN_AMOUNT',
    60: 'VAULT_NOT_FOUND',
    61: 'VAULT_LOCKED',
    62: 'VAULT_ALREADY_CLAIMED',
    63: 'VAULT_CANCELLED',
    64: 'INVALID_VAULT_CONFIG',
    65: 'NOTHING_TO_CLAIM',
};

/**
 * Decode a Soroban RPC simulation failure response into a user-facing message.
 * Call this BEFORE prompting the wallet so users see actionable feedback early.
 */
export function decodeSimulationError(simulationResponse: any): SimulationDecodeResult {
    const rawDetail = JSON.stringify(simulationResponse);

    // 1. Try to extract a symbolic error key from the error string
    const errorStr: string =
        simulationResponse?.error ??
        simulationResponse?.result?.error ??
        simulationResponse?.message ??
        '';

    // Match symbolic names like "Error(Contract, #7)" or "Error(TOKEN_NOT_FOUND)"
    const numericMatch = errorStr.match(/Error\s*\(\s*Contract\s*,\s*#(\d+)\s*\)/i);
    if (numericMatch) {
        const numCode = parseInt(numericMatch[1], 10);
        const symbolicKey = NUMERIC_CONTRACT_ERROR_MAP[numCode];
        if (symbolicKey && CONTRACT_ERROR_MAP[symbolicKey]) {
            const mapping = CONTRACT_ERROR_MAP[symbolicKey];
            return {
                userMessage: mapping.message,
                debugDetail: rawDetail,
                code: mapping.code,
                retryable: mapping.retryable,
                retrySuggestion: mapping.retrySuggestion,
            };
        }
    }

    const symbolicMatch = errorStr.match(/Error\(([A-Z_]+)\)/);
    if (symbolicMatch) {
        const key = symbolicMatch[1];
        if (CONTRACT_ERROR_MAP[key]) {
            const mapping = CONTRACT_ERROR_MAP[key];
            return {
                userMessage: mapping.message,
                debugDetail: rawDetail,
                code: mapping.code,
                retryable: mapping.retryable,
                retrySuggestion: mapping.retrySuggestion,
            };
        }
    }

    // 2. Insufficient fee heuristic
    if (/insufficient.*fee|fee.*insufficient/i.test(errorStr)) {
        return {
            userMessage: 'Insufficient fee — please ensure you have enough XLM',
            debugDetail: rawDetail,
            code: ErrorCode.INSUFFICIENT_BALANCE,
            retryable: true,
            retrySuggestion: 'Add more XLM to your wallet and try again',
        };
    }

    // 3. Fallback — unknown simulation error, preserve raw detail
    return {
        userMessage: 'Transaction simulation failed. Please check your inputs and try again.',
        debugDetail: rawDetail,
        code: ErrorCode.SIMULATION_FAILED,
        retryable: true,
        retrySuggestion: 'Review your parameters or contact support if the issue persists',
    };
}

/**
 * Parse failed transaction details from Soroban RPC response
 */
export function parseTransactionFailure(rpcResponse: any): TransactionFailureDetails {
    const failure: TransactionFailureDetails = {};

    if (rpcResponse.resultXdr) {
        try {
            // Extract result code from XDR
            failure.resultCode = extractResultCode(rpcResponse.resultXdr);
        } catch (err) {
            console.error('Failed to parse result XDR:', err);
        }
    }

    if (rpcResponse.diagnosticEventsXdr) {
        failure.diagnosticEvents = rpcResponse.diagnosticEventsXdr;
    }

    if (rpcResponse.error) {
        failure.rawError = typeof rpcResponse.error === 'string' 
            ? rpcResponse.error 
            : JSON.stringify(rpcResponse.error);
    }

    return failure;
}

/**
 * Extract human-readable result code from XDR
 */
function extractResultCode(resultXdr: string): string {
    // This is a simplified version - in production, you'd use stellar-sdk to parse XDR
    // For now, return the XDR as-is
    return resultXdr;
}

/**
 * Extract contract error code from error message or response
 */
function extractContractErrorCode(error: any): string | null {
    // Check for explicit contract error code
    if (error.contractErrorCode) {
        return error.contractErrorCode;
    }
    
    // Parse from error message: "Error(TOKEN_ALREADY_EXISTS)"
    if (error.message) {
        const match = error.message.match(/Error\(([A-Z_]+)\)/);
        if (match) {
            return match[1];
        }
    }
    
    // Parse from details
    if (error.details) {
        const match = error.details.match(/Error\(([A-Z_]+)\)/);
        if (match) {
            return match[1];
        }
    }
    
    return null;
}

/**
 * Parse contract-specific error using canonical error matrix
 */
function parseContractError(error: any, transactionFailure?: TransactionFailureDetails): StellarError {
    const errorCode = extractContractErrorCode(error);
    
    if (errorCode && CONTRACT_ERROR_MAP[errorCode]) {
        const mapping = CONTRACT_ERROR_MAP[errorCode];
        return new StellarError({
            code: mapping.code,
            message: mapping.message,
            details: mapping.details,
            retryable: mapping.retryable,
            retrySuggestion: mapping.retrySuggestion,
        }, {
            ...transactionFailure,
            contractErrorCode: errorCode,
        });
    }
    
    // Unknown contract error - preserve raw details
    return new StellarError({
        code: ErrorCode.CONTRACT_ERROR,
        message: 'Smart contract error occurred',
        details: errorCode ? `Error(${errorCode}): ${error.message || 'Unknown error'}` : error.message,
        retryable: true,
        retrySuggestion: 'Please try again or contact support',
    }, {
        ...transactionFailure,
        contractErrorCode: errorCode || undefined,
        rawError: JSON.stringify(error),
    });
}

/**
 * Parse Stellar error from various sources
 * Aligned with docs/CONTRACT_ERROR_MATRIX.md
 */
export function parseStellarError(error: unknown, transactionResponse?: any): StellarError {
    // Parse transaction failure details if available
    let transactionFailure: TransactionFailureDetails | undefined;
    if (transactionResponse && transactionResponse.status === 'FAILED') {
        transactionFailure = parseTransactionFailure(transactionResponse);
    }

    // Check for contract errors first (highest priority)
    const contractErrorCode = extractContractErrorCode(error);
    if (contractErrorCode) {
        return parseContractError(error, transactionFailure);
    }

    // Wallet not connected
    if (error instanceof Error && error.message.includes('Freighter')) {
        return new StellarError({
            code: ErrorCode.WALLET_NOT_CONNECTED,
            message: 'Please connect your wallet to continue',
            details: 'Freighter wallet not connected',
            retryable: true,
            retrySuggestion: 'Install Freighter extension and connect your wallet',
        }, transactionFailure);
    }

    // User rejected transaction (wallet rejection, not contract rejection)
    if (error instanceof Error && (
        error.message.includes('User declined') || 
        error.message.includes('rejected') ||
        error.message.includes('cancelled by user')
    )) {
        return new StellarError({
            code: ErrorCode.WALLET_REJECTED,
            message: 'Transaction was cancelled',
            details: 'You cancelled the transaction in your wallet',
            retryable: true,
            retrySuggestion: 'Try again and approve the transaction in your wallet',
        }, transactionFailure);
    }

    // Account not found
    if (error instanceof Error && error.message.includes('Account not found')) {
        return new StellarError({
            code: ErrorCode.ACCOUNT_NOT_FOUND,
            message: 'Account not found on network',
            details: 'The wallet address does not exist on the network',
            retryable: false,
            retrySuggestion: 'Ensure your wallet is funded with XLM',
        }, transactionFailure);
    }

    // Insufficient balance
    if (error instanceof Error && (error.message.includes('insufficient') || error.message.includes('balance'))) {
        return new StellarError({
            code: ErrorCode.INSUFFICIENT_BALANCE,
            message: 'Insufficient XLM balance for transaction fees',
            details: 'Not enough XLM to cover transaction fees',
            retryable: true,
            retrySuggestion: 'Add more XLM to your wallet and try again',
        }, transactionFailure);
    }

    // Simulation failed
    if (error instanceof Error && error.message.includes('Simulation failed')) {
        const details = extractSimulationError(error.message);
        return new StellarError({
            code: ErrorCode.SIMULATION_FAILED,
            message: 'Transaction simulation failed',
            details,
            retryable: true,
            retrySuggestion: 'Check your parameters and try again',
        }, transactionFailure);
    }

    // Timeout
    if (error instanceof Error && error.message.includes('timeout')) {
        return new StellarError({
            code: ErrorCode.TIMEOUT_ERROR,
            message: 'Transaction confirmation timeout',
            details: 'Transaction took too long to confirm',
            retryable: true,
            retrySuggestion: 'The network may be congested. Try again in a few moments',
        }, transactionFailure);
    }

    // Network error
    const lowerMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    
    if (lowerMessage.includes('network') || lowerMessage.includes('fetch')) {
        return new StellarError({
            code: ErrorCode.NETWORK_ERROR,
            message: 'Network error. Please check your connection',
            details: 'Failed to connect to Stellar network',
            retryable: true,
            retrySuggestion: 'Check your internet connection and try again',
        }, transactionFailure);
    }

    // Generic transaction failed
    if (error instanceof Error && error.message.includes('Transaction failed')) {
        return new StellarError({
            code: ErrorCode.TRANSACTION_FAILED,
            message: 'Transaction failed. Please try again',
            details: error.message,
            retryable: true,
            retrySuggestion: 'Review transaction details and try again',
        }, transactionFailure);
    }

    // Unknown error
    return new StellarError({
        code: ErrorCode.TRANSACTION_FAILED,
        message: 'An unexpected error occurred',
        details: error instanceof Error ? error.message : String(error),
        retryable: true,
        retrySuggestion: 'Please try again',
    }, transactionFailure);
}

function extractSimulationError(message: string): string {
    const match = message.match(/Simulation failed: (.+)/);
    return match ? match[1] : message;
}

export function logStellarError(error: StellarError, context?: Record<string, unknown>): void {
    const logData = {
        timestamp: new Date().toISOString(),
        errorCode: error.code,
        message: error.message,
        details: error.details,
        retryable: error.retryable,
        retrySuggestion: error.retrySuggestion,
        transactionFailure: error.transactionFailure,
        context,
    };

    if (process.env.NODE_ENV === 'development') {
        console.error('[StellarError]', logData);
    }

    // In production, this would send to monitoring service
    // Example: Sentry.captureException(error, { extra: logData });
}
