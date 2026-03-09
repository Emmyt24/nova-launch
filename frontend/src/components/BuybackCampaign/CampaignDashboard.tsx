import React, { useEffect, useState } from 'react';
import { ExecuteStepButton } from './ExecuteStepButton';

interface BuybackStep {
  id: number;
  stepNumber: number;
  amount: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  executedAt?: string;
  txHash?: string;
}

interface BuybackCampaign {
  id: number;
  tokenAddress: string;
  totalAmount: string;
  executedAmount: string;
  currentStep: number;
  totalSteps: number;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  createdAt: string;
  steps: BuybackStep[];
}

interface CampaignDashboardProps {
  campaignId: number;
}

export const CampaignDashboard: React.FC<CampaignDashboardProps> = ({
  campaignId,
}) => {
  const [campaign, setCampaign] = useState<BuybackCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCampaign = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/buyback/campaigns/${campaignId}`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch campaign');
      }

      const data = await response.json();
      setCampaign(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCampaign();
  }, [campaignId]);

  const handleStepSuccess = async (txHash: string) => {
    await fetchCampaign();
  };

  const handleStepError = (error: Error) => {
    console.error('Step execution failed:', error);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
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

  const progress = (campaign.currentStep / campaign.totalSteps) * 100;

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
              {progress.toFixed(0)}%
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className="bg-purple-600 h-3 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {campaign.status === 'ACTIVE' && (
          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-4">Current Step</h3>
            <ExecuteStepButton
              campaignId={campaign.id}
              currentStep={campaign.currentStep}
              stepAmount={campaign.steps[campaign.currentStep]?.amount || '0'}
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
                    href={`https://stellar.expert/explorer/testnet/tx/${step.txHash}`}
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
