import type { AppError } from '../types';
import { ErrorCode } from '../types';
import { LoggingService } from '../services/logging';
import type { ErrorContext } from '../services/logging';
import { decodeSimulationError } from '../services/stellarErrors';
import type { SimulationDecodeResult } from '../services/stellarErrors';

export type { SimulationDecodeResult };

/**
 * Convert a Soroban simulation failure into a user-facing AppError.
 * Preserves raw debug detail separately from the UI message.
 */
export function simulationFailureToAppError(simulationResponse: any): AppError & { debugDetail: string } {
    const decoded = decodeSimulationError(simulationResponse);
    return {
        code: decoded.code,
        message: decoded.userMessage,
        details: decoded.retrySuggestion,
        debugDetail: decoded.debugDetail,
    };
}

/**
 * Error handling utilities
 */

/**
 * Error messages aligned with docs/CONTRACT_ERROR_MATRIX.md
 * These messages must not drift independently from error codes
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
    [ErrorCode.WALLET_NOT_CONNECTED]: 'Please connect your wallet to continue',
    [ErrorCode.INSUFFICIENT_BALANCE]: 'Insufficient XLM balance for transaction fees',
    [ErrorCode.INVALID_INPUT]: 'Please check your input and try again',
    [ErrorCode.IPFS_UPLOAD_FAILED]: 'Failed to upload image to IPFS. Please try again',
    [ErrorCode.TRANSACTION_FAILED]: 'Transaction failed. Please try again',
    [ErrorCode.WALLET_REJECTED]: 'Transaction was cancelled',
    [ErrorCode.NETWORK_ERROR]: 'Network error. Please check your connection',
    [ErrorCode.SIMULATION_FAILED]: 'Transaction simulation failed',
    [ErrorCode.CONTRACT_ERROR]: 'Smart contract error occurred',
    [ErrorCode.TIMEOUT_ERROR]: 'Transaction confirmation timeout',
    [ErrorCode.ACCOUNT_NOT_FOUND]: 'Account not found on network',
    [ErrorCode.INVALID_SIGNATURE]: 'Invalid transaction signature',
    [ErrorCode.BURN_FAILED]: 'Token burn operation failed',
    [ErrorCode.INVALID_AMOUNT]: 'Invalid amount specified',
    [ErrorCode.UNAUTHORIZED]: 'You are not authorized to perform this action',
};

/**
 * Recovery suggestions aligned with docs/CONTRACT_ERROR_MATRIX.md
 */
export const ERROR_RECOVERY_SUGGESTIONS: Record<ErrorCode, string> = {
    [ErrorCode.WALLET_NOT_CONNECTED]: 'Install Freighter extension and connect your wallet',
    [ErrorCode.INSUFFICIENT_BALANCE]: 'Add more XLM to your wallet and try again',
    [ErrorCode.INVALID_INPUT]: 'Review all fields and fix validation errors',
    [ErrorCode.IPFS_UPLOAD_FAILED]: 'Use a smaller image or reduce metadata size',
    [ErrorCode.TRANSACTION_FAILED]: 'Review transaction details and try again',
    [ErrorCode.WALLET_REJECTED]: 'Try again and approve the transaction in your wallet',
    [ErrorCode.NETWORK_ERROR]: 'Check your internet connection and try again',
    [ErrorCode.SIMULATION_FAILED]: 'Check your parameters and try again',
    [ErrorCode.CONTRACT_ERROR]: 'Please try again or contact support',
    [ErrorCode.TIMEOUT_ERROR]: 'The network may be congested. Try again in a few moments',
    [ErrorCode.ACCOUNT_NOT_FOUND]: 'Ensure your wallet is funded with XLM',
    [ErrorCode.INVALID_SIGNATURE]: 'Re-sign with the connected wallet and retry',
    [ErrorCode.BURN_FAILED]: 'Verify burn parameters and try again',
    [ErrorCode.INVALID_AMOUNT]: 'Enter a valid amount and try again',
    [ErrorCode.UNAUTHORIZED]: 'You do not have permission for this operation',
};

export type ErrorSeverity = 'low' | 'medium' | 'high';

export interface HandledError extends AppError {
    severity: ErrorSeverity;
    recoverySuggestion: string;
}

let globalErrorListenersAttached = false;

export class ErrorHandler {
    static handle(error: Error, context?: ErrorContext): void {
        const severity = this.resolveSeverity(error);
        this.log(error, severity, context);
        this.report(error, context);
    }

    static log(error: Error, severity: ErrorSeverity, context?: ErrorContext): void {
        LoggingService.logError(error, severity, context);
    }

    static report(error: Error, context?: ErrorContext): void {
        LoggingService.reportToMonitoring(error, context);
    }

    static getUserMessage(error: Error): string {
        const appError = this.toAppError(error);
        return appError.details ? `${appError.message}: ${appError.details}` : appError.message;
    }

    static getRecoverySuggestion(error: Error): string {
        const appError = this.toAppError(error);
        return (ERROR_RECOVERY_SUGGESTIONS as Record<string, string>)[appError.code] || 'Please try again.';
    }

    static toHandledError(error: unknown): HandledError {
        const normalizedError = toNativeError(error);
        const appError = this.toAppError(normalizedError);

        return {
            ...appError,
            severity: this.resolveSeverity(normalizedError),
            recoverySuggestion: this.getRecoverySuggestion(normalizedError),
        };
    }

    private static toAppError(error: Error): AppError {
        const loweredMessage = error.message.toLowerCase();

        if (loweredMessage.includes('wallet') && loweredMessage.includes('connect')) {
            return createError(ErrorCode.WALLET_NOT_CONNECTED, error.message);
        }

        if (loweredMessage.includes('insufficient') || loweredMessage.includes('balance')) {
            return createError(ErrorCode.INSUFFICIENT_BALANCE, error.message);
        }

        if (loweredMessage.includes('network') || loweredMessage.includes('fetch')) {
            return createError(ErrorCode.NETWORK_ERROR, error.message);
        }

        if (loweredMessage.includes('timeout')) {
            return createError(ErrorCode.TIMEOUT_ERROR, error.message);
        }

        if (loweredMessage.includes('reject') || loweredMessage.includes('decline')) {
            return createError(ErrorCode.WALLET_REJECTED, error.message);
        }

        if (loweredMessage.includes('simulation')) {
            return createError(ErrorCode.SIMULATION_FAILED, error.message);
        }

        if (loweredMessage.includes('ipfs')) {
            return createError(ErrorCode.IPFS_UPLOAD_FAILED, error.message);
        }

        return createError(ErrorCode.TRANSACTION_FAILED, error.message);
    }

    private static resolveSeverity(error: Error): ErrorSeverity {
        const loweredMessage = error.message.toLowerCase();

        if (loweredMessage.includes('timeout') || loweredMessage.includes('network')) {
            return 'medium';
        }

        if (loweredMessage.includes('failed') || loweredMessage.includes('critical')) {
            return 'high';
        }

        return 'low';
    }
}

export function setupGlobalErrorHandling(): void {
    if (globalErrorListenersAttached || typeof window === 'undefined') {
        return;
    }

    globalErrorListenersAttached = true;
    LoggingService.init();

    window.addEventListener('error', (event) => {
        const error = event.error instanceof Error
            ? event.error
            : new Error(event.message || 'Unhandled script error');

        ErrorHandler.handle(error, {
            action: 'window.error',
            feature: 'global-runtime',
            metadata: {
                filename: event.filename,
                line: event.lineno,
                column: event.colno,
            },
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const error = toNativeError(event.reason);
        ErrorHandler.handle(error, {
            action: 'window.unhandledrejection',
            feature: 'global-runtime',
        });
    });
}

export function createError(code: ErrorCode, details?: string): AppError {
    return {
        code,
        message: ERROR_MESSAGES[code],
        details,
    };
}

export function isAppError(error: unknown): error is AppError {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        'message' in error
    );
}

export function getErrorMessage(error: unknown): string {
    const nativeError = toNativeError(error);
    return ErrorHandler.getUserMessage(nativeError);
}

function toNativeError(error: unknown): Error {
    if (isAppError(error)) {
        return new Error(error.details ? `${error.message}: ${error.details}` : error.message);
    }
    if (error instanceof Error) {
        return error;
    }
    if (typeof error === 'string') {
        return new Error(error);
    }
    return new Error('An unknown error occurred');
}
