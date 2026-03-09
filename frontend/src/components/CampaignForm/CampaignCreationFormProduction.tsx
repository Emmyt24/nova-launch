import { useState, useCallback, useEffect } from 'react';
import { Input } from '../UI/Input';
import { Button } from '../UI/Button';
import { Modal } from '../UI/Modal';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { useWallet } from '../../hooks/useWallet';
import { useCampaignCreation } from '../../hooks/useCampaignCreation';
import { ErrorHandler, getErrorMessage } from '../../utils/errors';
import {
  isValidCampaignTitle,
  isValidCampaignDescription,
  isValidCampaignBudget,
  isValidCampaignDuration,
  isValidSlippage,
  formatDuration,
  parseDurationToSeconds,
  validateCampaignForm,
  getFieldError,
} from '../../utils/campaignValidation';
import type { CampaignFormData } from '../../types/campaign';
import type { AppError } from '../../types';

interface CampaignCreationFormProductionProps {
  tokenAddress: string;
  onSuccess?: (campaignId: string, txHash: string) => void;
  onError?: (error: Error) => void;
}

const INITIAL_FORM_STATE: CampaignFormData = {
  title: '',
  description: '',
  budget: '',
  duration: 86400, // 1 day default
  slippage: 5, // 5% default
};

export function CampaignCreationFormProduction({
  tokenAddress,
  onSuccess,
  onError,
}: CampaignCreationFormProductionProps) {
  const { wallet } = useWallet();
  const { createCampaign, reset, cleanup, status, error, result, transactionState, isLoading } =
    useCampaignCreation({
      network: wallet.network,
      onSuccess: (res) => onSuccess?.(res.campaignId, res.transactionHash),
      onError: (err) => onError?.(new Error(err.message)),
    });

  const [formData, setFormData] = useState<CampaignFormData>(INITIAL_FORM_STATE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [durationUnit, setDurationUnit] = useState<'hours' | 'days' | 'weeks'>('days');
  const [durationValue, setDurationValue] = useState('1');
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  // Calculate fees
  const fees = {
    baseFee: '0.5',
    estimatedGasFee: '0.1',
    totalFee: '0.6',
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Validate field on change
  const validateField = useCallback(
    (field: keyof CampaignFormData, value: any): string => {
      return getFieldError(field, value);
    },
    []
  );

  // Handle field change
  const handleFieldChange = useCallback(
    (field: keyof CampaignFormData, value: any) => {
      setFormData((prev) => ({ ...prev, [field]: value }));

      // Validate on change if field was touched
      if (touched[field]) {
        const error = validateField(field, value);
        setErrors((prev) => ({ ...prev, [field]: error }));
      }
    },
    [touched, validateField]
  );

  // Handle duration value change
  const handleDurationValueChange = (value: string) => {
    setDurationValue(value);
    const seconds = parseDurationToSeconds(value, durationUnit);
    handleFieldChange('duration', seconds);
  };

  // Handle duration unit change
  const handleDurationUnitChange = (unit: 'hours' | 'days' | 'weeks') => {
    setDurationUnit(unit);
    const seconds = parseDurationToSeconds(durationValue, unit);
    handleFieldChange('duration', seconds);
  };

  // Handle field blur
  const handleFieldBlur = useCallback(
    (field: keyof CampaignFormData) => {
      setTouched((prev) => ({ ...prev, [field]: true }));
      const error = validateField(field, formData[field]);
      setErrors((prev) => ({ ...prev, [field]: error }));
    },
    [formData, validateField]
  );

  // Check if form is valid
  const isFormValid = useCallback((): boolean => {
    const validation = validateCampaignForm(formData);
    return validation.valid && wallet.connected;
  }, [formData, wallet.connected]);

  // Handle form submission
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      // Validate all fields
      const validation = validateCampaignForm(formData);
      if (!validation.valid) {
        setErrors(validation.errors);
        setTouched({
          title: true,
          description: true,
          budget: true,
          duration: true,
          slippage: true,
        });
        return;
      }

      // Check wallet connection
      if (!wallet.connected || !wallet.address) {
        const err = new Error('Wallet not connected');
        onError?.(err);
        return;
      }

      setShowConfirmDialog(true);
    },
    [formData, wallet, onError]
  );

  // Handle confirmed submission
  const handleConfirmedSubmit = useCallback(async () => {
    if (!wallet.address) return;

    try {
      await createCampaign({
        title: formData.title,
        description: formData.description,
        budget: formData.budget,
        duration: formData.duration,
        slippage: formData.slippage,
        creatorAddress: wallet.address,
        tokenAddress,
      });

      setShowConfirmDialog(false);
      setShowSuccessModal(true);
    } catch (err) {
      // Error is handled by the hook
      setShowConfirmDialog(false);
    }
  }, [wallet.address, createCampaign, formData, tokenAddress]);

  // Handle success modal close
  const handleSuccessClose = useCallback(() => {
    setShowSuccessModal(false);
    setFormData(INITIAL_FORM_STATE);
    setErrors({});
    setTouched({});
    setDurationValue('1');
    setDurationUnit('days');
    reset();
  }, [reset]);

  // Get success state for field
  const getFieldSuccess = (field: keyof CampaignFormData): boolean => {
    return touched[field] && !errors[field] && formData[field] !== '';
  };

  // Get user-friendly error message
  const getUserErrorMessage = (err: AppError | null): string => {
    if (!err) return '';
    if (err.details) return `${err.message}: ${err.details}`;
    return err.message;
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-6" data-testid="campaign-creation-form">
        {/* Error Alert */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4" role="alert">
            <h3 className="font-semibold text-red-900 mb-1">Campaign Creation Failed</h3>
            <p className="text-sm text-red-800 mb-3">{getUserErrorMessage(error)}</p>
            <button
              type="button"
              onClick={() => {
                reset();
              }}
              className="text-sm font-medium text-red-700 hover:text-red-900 underline"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Wallet Connection Status */}
        {!wallet.connected && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4" role="status">
            <p className="text-sm text-yellow-800">
              <span className="font-medium">Wallet Required:</span> Please connect your wallet to create a campaign.
            </p>
          </div>
        )}

        {/* Campaign Title */}
        <Input
          label="Campaign Title"
          value={formData.title}
          onChange={(e) => handleFieldChange('title', e.target.value)}
          onBlur={() => handleFieldBlur('title')}
          error={touched.title ? errors.title : ''}
          success={getFieldSuccess('title')}
          helperText="3-100 characters, alphanumeric with spaces and punctuation"
          placeholder="Summer Token Promotion"
          maxLength={100}
          required
          disabled={isLoading || !wallet.connected}
          data-testid="campaign-title-input"
        />

        {/* Campaign Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Campaign Description
          </label>
          <textarea
            value={formData.description}
            onChange={(e) => handleFieldChange('description', e.target.value)}
            onBlur={() => handleFieldBlur('description')}
            className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              touched.description && errors.description
                ? 'border-red-500'
                : getFieldSuccess('description')
                ? 'border-green-500'
                : 'border-gray-300'
            }`}
            placeholder="Describe your campaign goals and details..."
            maxLength={1000}
            rows={4}
            required
            disabled={isLoading || !wallet.connected}
            data-testid="campaign-description-input"
          />
          {touched.description && errors.description && (
            <p className="mt-1 text-sm text-red-600">{errors.description}</p>
          )}
          {!errors.description && (
            <p className="mt-1 text-sm text-gray-500">
              10-1000 characters ({formData.description.length}/1000)
            </p>
          )}
        </div>

        {/* Budget */}
        <Input
          label="Campaign Budget (XLM)"
          type="number"
          value={formData.budget}
          onChange={(e) => handleFieldChange('budget', e.target.value)}
          onBlur={() => handleFieldBlur('budget')}
          error={touched.budget ? errors.budget : ''}
          success={getFieldSuccess('budget')}
          helperText="Amount in XLM (up to 7 decimal places)"
          placeholder="1000.5"
          step="0.0000001"
          min="0"
          required
          disabled={isLoading || !wallet.connected}
          data-testid="campaign-budget-input"
        />

        {/* Duration */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">
            Campaign Duration
          </label>
          <div className="flex gap-2">
            <Input
              type="number"
              value={durationValue}
              onChange={(e) => handleDurationValueChange(e.target.value)}
              onBlur={() => handleFieldBlur('duration')}
              error={touched.duration ? errors.duration : ''}
              placeholder="1"
              min="0"
              step="0.1"
              className="flex-1"
              disabled={isLoading || !wallet.connected}
              data-testid="campaign-duration-value-input"
            />
            <select
              value={durationUnit}
              onChange={(e) => handleDurationUnitChange(e.target.value as 'hours' | 'days' | 'weeks')}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isLoading || !wallet.connected}
              data-testid="campaign-duration-unit-select"
            >
              <option value="hours">Hours</option>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
            </select>
          </div>
          {touched.duration && errors.duration && (
            <p className="text-sm text-red-600">{errors.duration}</p>
          )}
          {!errors.duration && formData.duration > 0 && (
            <p className="text-sm text-gray-500">
              Duration: {formatDuration(formData.duration)}
            </p>
          )}
        </div>

        {/* Slippage */}
        <Input
          label="Slippage Tolerance (%)"
          type="number"
          value={formData.slippage}
          onChange={(e) => handleFieldChange('slippage', parseFloat(e.target.value))}
          onBlur={() => handleFieldBlur('slippage')}
          error={touched.slippage ? errors.slippage : ''}
          success={getFieldSuccess('slippage')}
          helperText="Maximum acceptable price movement (0-100%)"
          placeholder="5"
          step="0.01"
          min="0"
          max="100"
          required
          disabled={isLoading || !wallet.connected}
          data-testid="campaign-slippage-input"
        />

        {/* Fee Breakdown */}
        <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
          <h3 className="font-medium text-blue-900 mb-2">Fee Breakdown</h3>
          <div className="space-y-1 text-sm text-blue-800">
            <div className="flex justify-between">
              <span>Base Fee:</span>
              <span>{fees.baseFee} XLM</span>
            </div>
            <div className="flex justify-between">
              <span>Estimated Gas:</span>
              <span>{fees.estimatedGasFee} XLM</span>
            </div>
            <div className="flex justify-between font-medium border-t border-blue-200 pt-1 mt-1">
              <span>Total Fee:</span>
              <span>{fees.totalFee} XLM</span>
            </div>
          </div>
        </div>

        {/* Submit Button */}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!isFormValid() || isLoading}
          loading={isLoading}
          data-testid="campaign-submit-button"
        >
          {isLoading ? 'Creating Campaign...' : 'Create Campaign'}
        </Button>
      </form>

      {/* Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showConfirmDialog}
        onClose={() => setShowConfirmDialog(false)}
        onConfirm={handleConfirmedSubmit}
        title="Confirm Campaign Creation"
        message={`Create campaign "${formData.title}" with a budget of ${formData.budget} XLM?`}
        action="custom"
        fees={[
          { label: 'Base Fee', amount: `${fees.baseFee} XLM` },
          { label: 'Estimated Gas', amount: `${fees.estimatedGasFee} XLM` },
        ]}
        consequences={[
          'This action will submit a transaction to the Stellar network',
          `Campaign will run for ${formatDuration(formData.duration)}`,
          `Slippage tolerance set to ${formData.slippage}%`,
        ]}
        confirmText="Create Campaign"
        cancelText="Cancel"
        requireExplicitConfirm={false}
        isProcessing={status === 'submitting'}
        data-testid="campaign-confirm-dialog"
      />

      {/* Success Modal */}
      <Modal
        isOpen={showSuccessModal && status === 'success'}
        onClose={handleSuccessClose}
        title="Campaign Created Successfully"
        size="md"
        footer={
          <Button onClick={handleSuccessClose} variant="primary">
            Done
          </Button>
        }
        data-testid="campaign-success-modal"
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-green-50 border border-green-200 p-4">
            <p className="text-sm text-green-800">
              Your campaign has been created and submitted to the Stellar network.
            </p>
          </div>

          {result && (
            <div className="space-y-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500">Campaign ID</p>
                <p className="break-all text-sm font-mono text-gray-900">{result.campaignId}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500">Transaction Hash</p>
                <p className="break-all text-sm font-mono text-gray-900">{result.transactionHash}</p>
              </div>
              {transactionState && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Status</p>
                  <p className="text-sm capitalize text-gray-900">{transactionState.status}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
