import { useState, useCallback, useRef, useEffect } from 'react';
import type { CampaignParams, CampaignCreationResult, CampaignStatus, CampaignTransactionState } from '../types/campaign';
import type { AppError } from '../types';
import { ErrorCode } from '../types';
import { CampaignService } from '../services/campaignService';
import { ErrorHandler, createError } from '../utils/errors';
import { TransactionMonitor } from '../services/transactionMonitor';

interface UseCampaignCreationOptions {
  network?: 'testnet' | 'mainnet';
  onSuccess?: (result: CampaignCreationResult) => void;
  onError?: (error: AppError) => void;
}

export function useCampaignCreation(options: UseCampaignCreationOptions = {}) {
  const { network = 'testnet', onSuccess, onError } = options;
  
  const [status, setStatus] = useState<CampaignStatus>('idle');
  const [error, setError] = useState<AppError | null>(null);
  const [result, setResult] = useState<CampaignCreationResult | null>(null);
  const [transactionState, setTransactionState] = useState<CampaignTransactionState | null>(null);
  
  const campaignServiceRef = useRef(new CampaignService(network));
  const monitorRef = useRef(new TransactionMonitor());
  const currentHashRef = useRef<string | null>(null);

  const createCampaign = useCallback(
    async (params: CampaignParams): Promise<CampaignCreationResult> => {
      setStatus('validating');
      setError(null);
      setResult(null);
      setTransactionState(null);

      try {
        // Validate parameters
        if (!params.title?.trim()) {
          throw createError(ErrorCode.INVALID_INPUT, 'Campaign title is required');
        }
        if (!params.description?.trim()) {
          throw createError(ErrorCode.INVALID_INPUT, 'Campaign description is required');
        }
        if (!params.budget || parseFloat(params.budget) <= 0) {
          throw createError(ErrorCode.INVALID_INPUT, 'Budget must be greater than 0');
        }
        if (params.duration < 3600 || params.duration > 31536000) {
          throw createError(ErrorCode.INVALID_INPUT, 'Duration must be between 1 hour and 1 year');
        }
        if (params.slippage < 0 || params.slippage > 100) {
          throw createError(ErrorCode.INVALID_INPUT, 'Slippage must be between 0% and 100%');
        }
        if (!params.creatorAddress?.startsWith('G')) {
          throw createError(ErrorCode.INVALID_INPUT, 'Invalid creator address');
        }
        if (!params.tokenAddress?.startsWith('C')) {
          throw createError(ErrorCode.INVALID_INPUT, 'Invalid token address');
        }

        setStatus('submitting');

        // Create campaign
        const creationResult = await campaignServiceRef.current.createCampaign(params);
        
        // Monitor transaction
        currentHashRef.current = creationResult.transactionHash;
        setTransactionState({
          hash: creationResult.transactionHash,
          status: 'pending',
          timestamp: Date.now(),
        });

        monitorRef.current.startMonitoring(
          creationResult.transactionHash,
          (update) => {
            setTransactionState({
              hash: update.hash,
              status: update.status,
              timestamp: update.timestamp,
              error: update.error,
            });

            if (update.status === 'success') {
              setStatus('success');
              setResult(creationResult);
              onSuccess?.(creationResult);
            } else if (update.status === 'failed' || update.status === 'timeout') {
              const txError = createError(
                ErrorCode.TRANSACTION_FAILED,
                `Transaction ${update.status}`
              );
              if (update.error) {
                txError.details = update.error;
              }
              setError(txError);
              setStatus('error');
              onError?.(txError);
            }
          },
          (err) => {
            const appError = createError(
              ErrorCode.NETWORK_ERROR,
              'Failed to monitor transaction'
            );
            appError.details = err.message;
            setError(appError);
            setStatus('error');
            onError?.(appError);
          }
        );

        return creationResult;
      } catch (err) {
        let appError: AppError;
        
        if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
          appError = err as AppError;
        } else if (err instanceof Error) {
          appError = createError(ErrorCode.TRANSACTION_FAILED, err.message);
        } else {
          appError = createError(ErrorCode.TRANSACTION_FAILED, 'Campaign creation failed');
        }
        
        setError(appError);
        setStatus('error');
        onError?.(appError);
        
        ErrorHandler.handle(
          err instanceof Error ? err : new Error(appError.message),
          {
            action: 'campaign_creation',
            feature: 'campaign-form',
            metadata: { network },
          }
        );

        throw appError;
      }
    },
    [network, onSuccess, onError]
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setResult(null);
    setTransactionState(null);
    if (currentHashRef.current) {
      monitorRef.current.stopMonitoring(currentHashRef.current);
      currentHashRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    monitorRef.current.destroy();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    createCampaign,
    reset,
    cleanup,
    status,
    error,
    result,
    transactionState,
    isLoading: status === 'validating' || status === 'submitting',
  };
}
