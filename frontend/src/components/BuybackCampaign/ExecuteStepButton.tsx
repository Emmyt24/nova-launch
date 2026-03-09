import React, { useState } from 'react';
import { useStellar } from '../../hooks/useStellar';
import { useWallet } from '../../hooks/useWallet';

interface ExecuteStepButtonProps {
  campaignId: number;
  currentStep: number;
  stepAmount: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  onSuccess?: (txHash: string) => void;
  onError?: (error: Error) => void;
}

type TransactionState = 'idle' | 'pending' | 'success' | 'failure';

export const ExecuteStepButton: React.FC<ExecuteStepButtonProps> = ({
  campaignId,
  currentStep,
  stepAmount,
  status,
  onSuccess,
  onError,
}) => {
  const { wallet } = useWallet();
  const { executeBuybackStep } = useStellar();
  const [txState, setTxState] = useState<TransactionState>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isDisabled =
    !wallet ||
    status !== 'ACTIVE' ||
    txState === 'pending' ||
    txState === 'success';

  const handleExecute = async () => {
    if (!wallet) {
      setError('Wallet not connected');
      return;
    }

    try {
      setTxState('pending');
      setError(null);
      setTxHash(null);

      const result = await executeBuybackStep(campaignId, wallet.address);

      setTxHash(result.txHash);
      setTxState('success');

      if (onSuccess) {
        onSuccess(result.txHash);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Transaction failed';
      setError(errorMessage);
      setTxState('failure');

      if (onError && err instanceof Error) {
        onError(err);
      }
    }
  };

  const getButtonText = () => {
    switch (txState) {
      case 'pending':
        return 'Executing...';
      case 'success':
        return 'Executed ✓';
      case 'failure':
        return 'Retry';
      default:
        return `Execute Step ${currentStep + 1}`;
    }
  };

  const getButtonClass = () => {
    const baseClass =
      'px-6 py-3 rounded-lg font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2';

    if (isDisabled) {
      return `${baseClass} bg-gray-300 text-gray-500 cursor-not-allowed`;
    }

    switch (txState) {
      case 'pending':
        return `${baseClass} bg-blue-500 text-white cursor-wait`;
      case 'success':
        return `${baseClass} bg-green-500 text-white`;
      case 'failure':
        return `${baseClass} bg-red-500 text-white hover:bg-red-600 focus:ring-red-500`;
      default:
        return `${baseClass} bg-purple-600 text-white hover:bg-purple-700 focus:ring-purple-500`;
    }
  };

  return (
    <div className="space-y-4">
      <button
        onClick={handleExecute}
        disabled={isDisabled}
        className={getButtonClass()}
        aria-label={`Execute buyback step ${currentStep + 1}`}
      >
        {txState === 'pending' && (
          <span className="inline-block mr-2 animate-spin">⏳</span>
        )}
        {getButtonText()}
      </button>

      {txState === 'pending' && (
        <div className="flex items-center space-x-2 text-sm text-gray-600">
          <div className="animate-pulse">Processing transaction...</div>
        </div>
      )}

      {txState === 'success' && txHash && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-medium text-green-800 mb-2">
            Transaction Successful!
          </p>
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:text-blue-800 underline break-all"
          >
            View on Stellar Expert: {txHash.slice(0, 16)}...
          </a>
        </div>
      )}

      {txState === 'failure' && error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm font-medium text-red-800 mb-1">
            Transaction Failed
          </p>
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {status !== 'ACTIVE' && (
        <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
          <p className="text-sm text-gray-600">
            Campaign is {status.toLowerCase()}. Cannot execute steps.
          </p>
        </div>
      )}
    </div>
  );
};
