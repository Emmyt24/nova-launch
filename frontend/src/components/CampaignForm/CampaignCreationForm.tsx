import { useState, useCallback, useEffect } from 'react';
import { Input } from '../UI/Input';
import { Button } from '../UI/Button';
import { HandledErrorAlert } from '../UI/HandledErrorAlert';
import { useWallet } from '../../hooks/useWallet';
import { useToastContext } from '../../providers/ToastProvider';
import { CampaignService } from '../../services/campaignService';
import { ErrorHandler } from '../../utils/errors';
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
import type { CampaignFormData, CampaignStatus } from '../../types/campaign';

interface CampaignCreationFormProps {
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

export function CampaignCreationForm({
  tokenAddress,
  onSuccess,
  onError,
}: CampaignCreationFormProps) {
  const { wallet, isConnecting: walletConnecting } = useWallet();
  const { error: toastError } = useToastContext();
  const [formData, setFormData] = useState<CampaignFormData>(INITIAL_FORM_STATE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<CampaignStatus>('idle');
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [durationUnit, setDurationUnit] = useState<'hours' | 'days' | 'weeks'>('days');
  const [durationValue, setDurationValue] = useState('1');

  const campaignService = new CampaignService(wallet.network);

  // Calculate fees
  const fees = campaignService.calculateFees(formData.budget);

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
        setSubmitError(new Error('Wallet not connected'));
        return;
      }

      setStatus('submitting');
      setSubmitError(null);

      try {
        const result = await campaignService.createCampaign({
          title: formData.title,
          description: formData.description,
          budget: formData.budget,
          duration: formData.duration,
          slippage: formData.slippage,
          creatorAddress: wallet.address,
          tokenAddress,
        });

        setStatus('success');
        toastError?.('success', `Campaign created successfully! ID: ${result.campaignId}`);

        // Reset form
        setFormData(INITIAL_FORM_STATE);
        setErrors({});
        setTouched({});
        setDurationValue('1');
        setDurationUnit('days');

        // Call success callback
        onSuccess?.(result.campaignId, result.transactionHash);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        setStatus('error');
        setSubmitError(err);
        ErrorHandler.handle(err, {
          action: 'campaign_creation',
          feature: 'campaign-form',
          metadata: { tokenAddress },
        });
        onError?.(err);
      }
    },
    [formData, wallet, tokenAddress, campaignService, toastError, onSuccess, onError]
  );

  // Get success state for field
  const getFieldSuccess = (field: keyof CampaignFormData): boolean => {
    return touched[field] && !errors[field] && formData[field] !== '';
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Error Alert */}
      {submitError && (
        <HandledErrorAlert
          error={submitError}
          title="Campaign Creation Failed"
          onRecoveryAction={() => setSubmitError(null)}
          recoveryActionLabel="Dismiss"
        />
      )}

      {/* Wallet Connection Status */}
      {!wallet.connected && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
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
        disabled={status === 'submitting' || walletConnecting}
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
          disabled={status === 'submitting' || walletConnecting}
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
        disabled={status === 'submitting' || walletConnecting}
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
            disabled={status === 'submitting' || walletConnecting}
          />
          <select
            value={durationUnit}
            onChange={(e) => handleDurationUnitChange(e.target.value as 'hours' | 'days' | 'weeks')}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={status === 'submitting' || walletConnecting}
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
        disabled={status === 'submitting' || walletConnecting}
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
        disabled={!isFormValid() || status === 'submitting' || walletConnecting}
        loading={status === 'submitting'}
      >
        {status === 'submitting' ? 'Creating Campaign...' : 'Create Campaign'}
      </Button>

      {/* Success Message */}
      {status === 'success' && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm text-green-800">
            <span className="font-medium">Success!</span> Your campaign has been created successfully.
          </p>
        </div>
      )}
    </form>
  );
}
