import React, { useCallback, useEffect, useState } from 'react';
import { ExecuteStepButton } from './ExecuteStepButton';
import { StellarService } from '../../services/stellar.service';
import { mapBuybackCampaign } from '../../services/mappers/buybackCampaignMapper';
import type { BuybackCampaignModel } from '../../types/campaign';
import { useProjectionRefresh } from '../../hooks/useProjectionRefresh';
import { campaignApi } from '../../services/campaignApi';
import { getTxUrl } from '../../utils/explorer';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? '';

interface CampaignDashboardProps {
  campaignId: number;
  network?: 'testnet' | 'mainnet';
}

export const CampaignDashboard: React.FC<CampaignDashboardProps> = ({
  campaignId,
  network = 'testnet',
}) => {
  const [campaign, setCampaign] = useState<BuybackCampaignModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // txHash of the most recently submitted step — drives projection polling
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null);

  const fetchCampaign = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/campaigns/${campaignId}`);
      if (!response.ok) throw new Error('Failed to fetch campaign');
      const data = await response.json();
      setCampaign(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchCampaign();
  }, [fetchCampaign]);

  // Projection refresh — polls until the backend execution count advances
  const expectedExecutionCount = campaign ? campaign.currentStep + 1 : 0;
  const { status: projectionStatus, retry: retryProjection } = useProjectionRefresh({
    txHash: pendingTxHash,
    check: useCallback(async () => {
      const projection = await campaignApi.getById(campaignId);
      return projection.executionCount >= expectedExecutionCount;
    }, [campaignId, expectedExecutionCount]),
    onIndexed: useCallback(() => {
      setPendingTxHash(null);
      fetchCampaign();
    }, [fetchCampaign]),
  });

  const handleStepSuccess = useCallback((txHash: string) => {
    // Start projection polling — don't re-fetch immediately, wait for backend catch-up
    setPendingTxHash(txHash);
  }, []);

  const handleStepError = useCallback((err: Error) => {
    console.error('Step execution failed:', err);
    fetchCampaign();
  }, [fetchCampaign]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div
          role="status"
          aria-label="Loading"
          className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"
        />
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-red-800">{error || 'Campaign not found'}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">
            Buyback Campaign #{campaign.id}
          </h2>
          <span
            className={`px-4 py-2 rounded-full text-sm font-semibold ${
              campaign.status === 'ACTIVE'
                ? 'bg-green-100 text-green-800'
                : campaign.status === 'COMPLETED'
                ? 'bg-blue-100 text-blue-800'
                : 'bg-gray-100 text-gray-800'
            }`}
          >
            {campaign.status}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <p className="text-sm text-gray-600">Token Address</p>
            <p className="font-mono text-sm break-all">{campaign.tokenAddress}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Total Amount</p>
            <p className="font-semibold">{campaign.totalAmount}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Executed Amount</p>
            <p className="font-semibold">{campaign.executedAmount}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Progress</p>
            <p className="font-semibold">
              {campaign.currentStep} / {campaign.totalSteps} steps
            </p>
          </div>
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Progress</span>
            <span className="text-sm font-medium text-gray-700">
              {campaign.progressPercent.toFixed(0)}%
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className="bg-purple-600 h-3 rounded-full transition-all duration-500"
              style={{ width: `${campaign.progressPercent}%` }}
            />
          </div>
        </div>

        {campaign.isActive && (
          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-4">Current Step</h3>

            {/* Projection catch-up indicator */}
            {projectionStatus === 'polling' && (
              <div className="mb-3 flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-md px-4 py-2">
                <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Waiting for backend to index the transaction…
              </div>
            )}
            {projectionStatus === 'failed' && (
              <div className="mb-3 flex items-center justify-between text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-4 py-2">
                <span>⚠️ Backend sync timed out — data may be stale</span>
                <button
                  onClick={retryProjection}
                  className="ml-4 text-xs underline hover:no-underline"
                >
                  Retry
                </button>
              </div>
            )}

            <ExecuteStepButton
              campaignId={campaign.id}
              currentStep={campaign.currentStep}
              stepAmount={campaign.steps[campaign.currentStep]?.amount ?? '0'}
              status={campaign.status}
              onSuccess={handleStepSuccess}
              onError={handleStepError}
            />
          </div>
        )}

        <div>
          <h3 className="text-lg font-semibold mb-4">All Steps</h3>
          <div className="space-y-3">
            {campaign.steps.map((step) => (
              <div
                key={step.id}
                className={`p-4 rounded-lg border-2 ${
                  step.status === 'COMPLETED'
                    ? 'bg-green-50 border-green-200'
                    : step.status === 'FAILED'
                    ? 'bg-red-50 border-red-200'
                    : step.stepNumber === campaign.currentStep
                    ? 'bg-blue-50 border-blue-300'
                    : 'bg-gray-50 border-gray-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">
                      Step {step.stepNumber + 1}
                      {step.stepNumber === campaign.currentStep && (
                        <span className="ml-2 text-blue-600">(Current)</span>
                      )}
                    </p>
                    <p className="text-sm text-gray-600">Amount: {step.amount}</p>
                  </div>
                  <div className="text-right">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${
                        step.status === 'COMPLETED'
                          ? 'bg-green-200 text-green-800'
                          : step.status === 'FAILED'
                          ? 'bg-red-200 text-red-800'
                          : 'bg-gray-200 text-gray-800'
                      }`}
                    >
                      {step.status}
                    </span>
                    {step.executedAt && (
                      <p className="text-xs text-gray-500 mt-1">
                        {new Date(step.executedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
                {step.txHash && (
                  <a
                    href={getTxUrl(step.txHash, network)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-800 underline mt-2 block"
                  >
                    View Transaction
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
