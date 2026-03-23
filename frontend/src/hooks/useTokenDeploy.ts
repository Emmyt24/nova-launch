import { useMemo, useState } from 'react';
import type { AppError, DeploymentResult, DeploymentStatus, TokenDeployParams, TokenInfo } from '../types';
import { ErrorCode } from '../types';
import { createError, ErrorHandler, getErrorMessage } from '../utils/errors';
import {
    isValidDescription,
    isValidImageFile,
    validateTokenParams,
} from '../utils/validation';
import { IPFSService } from '../services/IPFSService';
import { StellarService } from '../services/stellar.service';
import { getDeploymentFeeBreakdown } from '../utils/feeCalculation';
import { analytics, AnalyticsEvent } from '../services/analytics';
import { useAnalytics } from './useAnalytics';
import { transactionHistoryStorage } from '../services/TransactionHistoryStorage';

const STATUS_MESSAGES: Record<DeploymentStatus, string> = {
    idle: '',
    uploading: 'Uploading metadata to IPFS...',
    deploying: 'Building transaction, requesting signature, and submitting to Stellar...',
    success: 'Deployment complete.',
    error: 'Deployment failed.',
};

interface UseTokenDeployOptions {
    maxRetries?: number;
    retryDelay?: number;
}

export function useTokenDeploy(network: 'testnet' | 'mainnet', options: UseTokenDeployOptions = {}) {
    const { maxRetries = 3, retryDelay = 2000 } = options;
    const [status, setStatus] = useState<DeploymentStatus>('idle');
    const [error, setError] = useState<AppError | null>(null);
    const [retryCount, setRetryCount] = useState(0);
    const [lastParams, setLastParams] = useState<TokenDeployParams | null>(null);

    const stellarService = useMemo(() => new StellarService(network), [network]);
    const ipfsService = useMemo(() => new IPFSService(), []);
    const { trackTokenDeployed, trackTokenDeployFailed } = useAnalytics();

    const deploy = async (params: TokenDeployParams): Promise<DeploymentResult> => {
        setError(null);
        setStatus('idle');
        setLastParams(params);
        setRetryCount(0);

        // Track initiation (no PII). Do NOT include wallet or addresses.
        try {
            analytics.track('token_deploy_initiated', {
                network,
                name_length: params.name ? params.name.length : 0,
                symbol: params.symbol || '',
                decimals: params.decimals || 0,
                has_metadata: Boolean(params.metadata || params.metadataUri),
            });
        } catch {}

        const validation = validateTokenParams(params);
        if (!validation.valid) {
            const details = Object.values(validation.errors).join(' ');
            const appError = createError(ErrorCode.INVALID_INPUT, details);
            setError(appError);
            setStatus('error');
            try {
                analytics.track(AnalyticsEvent.TOKEN_DEPLOY_FAILED, {
                    network,
                    errorCode: appError.code,
                });
            } catch {}
            throw appError;
        }

        let metadataUri = params.metadataUri;
        if (params.metadata) {
            const imageValidation = isValidImageFile(params.metadata.image);
            if (!imageValidation.valid) {
                const appError = createError(
                    ErrorCode.INVALID_INPUT,
                    imageValidation.error || 'Invalid metadata image'
                );
                setError(appError);
                setStatus('error');
                throw appError;
            }

            if (!isValidDescription(params.metadata.description)) {
                const appError = createError(
                    ErrorCode.INVALID_INPUT,
                    'Metadata description must be 500 characters or fewer'
                );
                setError(appError);
                setStatus('error');
                throw appError;
            }

            setStatus('uploading');
            try {
                metadataUri = await ipfsService.uploadMetadata(
                    params.metadata.image,
                    params.metadata.description,
                    params.name
                );
            } catch (uploadError) {
                ErrorHandler.handle(uploadError instanceof Error ? uploadError : new Error(getErrorMessage(uploadError)), {
                    action: 'upload-metadata',
                    feature: 'token-deploy',
                });
                const appError = createError(ErrorCode.IPFS_UPLOAD_FAILED, getErrorMessage(uploadError));
                setError(appError);
                setStatus('error');
                try {
                    analytics.track(AnalyticsEvent.TOKEN_DEPLOY_FAILED, {
                        network,
                        errorCode: appError.code,
                    });
                } catch {}
                throw appError;
            }
        }

        setStatus('deploying');
        
        // Check if factory is paused before attempting deployment
        try {
            const isPaused = await stellarService.isPaused();
            if (isPaused) {
                const appError = createError(
                    ErrorCode.CONTRACT_ERROR,
                    'Protocol is currently paused for maintenance',
                    `The factory contract on ${network} is paused. Please try again later or contact support.`
                );
                setError(appError);
                setStatus('error');
                try {
                    analytics.track(AnalyticsEvent.TOKEN_DEPLOY_FAILED, {
                        network,
                        errorCode: appError.code,
                        reason: 'protocol_paused',
                    });
                } catch {}
                throw appError;
            }
        } catch (pauseCheckError) {
            // If pause check fails, log but continue (fail open to avoid blocking users)
            console.warn('Failed to check pause state, continuing with deployment:', pauseCheckError);
        }

        try {
            const result = await stellarService.deployToken({
                ...params,
                metadataUri,
            });
            try {
                analytics.track(AnalyticsEvent.TOKEN_DEPLOYED, {
                    network,
                    name_length: params.name ? params.name.length : 0,
                    symbol: params.symbol || '',
                    decimals: params.decimals || 0,
                });
            } catch {}
            
            // Save optimistic record to local storage
            // Backend sync will happen via useTransactionHistory
            saveDeploymentRecord(params, result, metadataUri);
            
            setStatus('success');
            trackTokenDeployed(params.symbol, network);
            return result;
        } catch (deployError) {
            ErrorHandler.handle(deployError instanceof Error ? deployError : new Error(getErrorMessage(deployError)), {
                action: 'deploy-token',
                feature: 'token-deploy',
                metadata: {
                    name: params.name,
                    symbol: params.symbol,
                    hasMetadata: Boolean(metadataUri),
                },
            });
            const appError = mapDeploymentError(deployError);
            try {
                analytics.track(AnalyticsEvent.TOKEN_DEPLOY_FAILED, {
                    network,
                    errorCode: appError.code,
                });
            } catch {}
            setError(appError);
            setStatus('error');
            trackTokenDeployFailed(appError.message, network);
            throw appError;
        }
    };

    const reset = () => {
        setStatus('idle');
        setError(null);
        setRetryCount(0);
        setLastParams(null);
    };

    const retry = async (): Promise<DeploymentResult | null> => {
        if (!lastParams) {
            const appError = createError(ErrorCode.INVALID_INPUT, 'No previous deployment to retry');
            setError(appError);
            return null;
        }

        if (retryCount >= maxRetries) {
            const appError = createError(
                ErrorCode.TRANSACTION_FAILED,
                `Maximum retry attempts (${maxRetries}) reached`
            );
            setError(appError);
            return null;
        }

        setRetryCount(prev => prev + 1);
        
        // Add delay before retry
        if (retryDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
        
        return deploy(lastParams);
    };

    return {
        deploy,
        retry,
        reset,
        status,
        statusMessage: STATUS_MESSAGES[status],
        isDeploying: status === 'uploading' || status === 'deploying',
        error,
        retryCount,
        canRetry: retryCount < maxRetries && lastParams !== null && status === 'error',
        getFeeBreakdown: getDeploymentFeeBreakdown,
    };
}

/**
 * Save deployment record to local storage (optimistic update)
 * Backend sync will reconcile this later
 */
function saveDeploymentRecord(
    params: TokenDeployParams,
    result: DeploymentResult,
    metadataUri?: string
): void {
    const token: TokenInfo = {
        address: result.tokenAddress,
        name: params.name,
        symbol: params.symbol,
        decimals: params.decimals,
        totalSupply: params.initialSupply,
        creator: params.adminWallet,
        metadataUri,
        deployedAt: result.timestamp,
        transactionHash: result.transactionHash,
    };

    // Use the new TransactionHistoryStorage service
    transactionHistoryStorage.addToken(params.adminWallet, token);
}

function mapDeploymentError(error: unknown): AppError {
    const message = getErrorMessage(error);
    const normalizedMessage = message.toLowerCase();

    if (normalizedMessage.includes('wallet') || normalizedMessage.includes('sign')) {
        return createError(ErrorCode.WALLET_REJECTED, message);
    }

    if (normalizedMessage.includes('network')) {
        return createError(ErrorCode.NETWORK_ERROR, message);
    }

    if (normalizedMessage.includes('simulate') || normalizedMessage.includes('transaction')) {
        return createError(ErrorCode.TRANSACTION_FAILED, message);
    }

    return createError(ErrorCode.TRANSACTION_FAILED, message);
}
