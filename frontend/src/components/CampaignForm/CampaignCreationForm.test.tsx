import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CampaignCreationFormProduction } from './CampaignCreationFormProduction';
import * as campaignValidation from '../../utils/campaignValidation';

// Mock dependencies
vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => ({
    wallet: {
      connected: true,
      address: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
      network: 'testnet',
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnecting: false,
    error: null,
  }),
}));

vi.mock('../../hooks/useCampaignCreation', () => ({
  useCampaignCreation: () => ({
    createCampaign: vi.fn().mockResolvedValue({
      campaignId: 'campaign_abc123',
      transactionHash: 'a'.repeat(64),
      timestamp: Date.now(),
      totalCost: '0.6',
    }),
    reset: vi.fn(),
    cleanup: vi.fn(),
    status: 'idle',
    error: null,
    result: null,
    transactionState: null,
    isLoading: false,
  }),
}));

describe('CampaignCreationFormProduction', () => {
  const defaultProps = {
    tokenAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Form Rendering', () => {
    it('should render all form fields', () => {
      render(<CampaignCreationFormProduction {...defaultProps} />);

      expect(screen.getByTestId('campaign-title-input')).toBeInTheDocument();
      expect(screen.getByTestId('campaign-description-input')).toBeInTheDocument();
      expect(screen.getByTestId('campaign-budget-input')).toBeInTheDocument();
      expect(screen.getByTestId('campaign-duration-value-input')).toBeInTheDocument();
      expect(screen.getByTestId('campaign-duration-unit-select')).toBeInTheDocument();
      expect(screen.getByTestId('campaign-slippage-input')).toBeInTheDocument();
    });

    it('should render submit button', () => {
      render(<CampaignCreationFormProduction {...defaultProps} />);
      expect(screen.getByTestId('campaign-submit-button')).toBeInTheDocument();
    });

    it('should render fee breakdown', () => {
      render(<CampaignCreationFormProduction {...defaultProps} />);
      expect(screen.getByText('Fee Breakdown')).toBeInTheDocument();
      expect(screen.getByText(/Base Fee/)).toBeInTheDocument();
      expect(screen.getByText(/Estimated Gas/)).toBeInTheDocument();
      expect(screen.getByText(/Total Fee/)).toBeInTheDocument();
    });

    it('should have submit button disabled initially', () => {
      render(<CampaignCreationFormProduction {...defaultProps} />);
      const submitButton = screen.getByTestId('campaign-submit-button');
      expect(submitButton).toBeDisabled();
    });
  });

  describe('Form Validation', () => {
    it('should validate title field', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const titleInput = screen.getByTestId('campaign-title-input');

      // Test too short
      await user.type(titleInput, 'ab');
      await user.tab();
      expect(screen.getByText(/Title must be/)).toBeInTheDocument();

      // Test valid
      await user.clear(titleInput);
      await user.type(titleInput, 'Valid Campaign Title');
      await user.tab();
      expect(screen.queryByText(/Title must be/)).not.toBeInTheDocument();
    });

    it('should validate description field', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const descriptionInput = screen.getByTestId('campaign-description-input');

      // Test too short
      await user.type(descriptionInput, 'short');
      await user.tab();
      expect(screen.getByText(/Description must be/)).toBeInTheDocument();

      // Test valid
      await user.clear(descriptionInput);
      await user.type(descriptionInput, 'This is a valid campaign description with enough characters');
      await user.tab();
      expect(screen.queryByText(/Description must be/)).not.toBeInTheDocument();
    });

    it('should validate budget field', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const budgetInput = screen.getByTestId('campaign-budget-input');

      // Test invalid (zero)
      await user.type(budgetInput, '0');
      await user.tab();
      expect(screen.getByText(/Budget must be/)).toBeInTheDocument();

      // Test valid
      await user.clear(budgetInput);
      await user.type(budgetInput, '1000.5');
      await user.tab();
      expect(screen.queryByText(/Budget must be/)).not.toBeInTheDocument();
    });

    it('should validate duration field', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const durationInput = screen.getByTestId('campaign-duration-value-input');

      // Test invalid (too small)
      await user.type(durationInput, '0.01');
      await user.tab();
      expect(screen.getByText(/Duration must be/)).toBeInTheDocument();

      // Test valid
      await user.clear(durationInput);
      await user.type(durationInput, '1');
      await user.tab();
      expect(screen.queryByText(/Duration must be/)).not.toBeInTheDocument();
    });

    it('should validate slippage field', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const slippageInput = screen.getByTestId('campaign-slippage-input');

      // Test invalid (too high)
      await user.type(slippageInput, '150');
      await user.tab();
      expect(screen.getByText(/Slippage must be/)).toBeInTheDocument();

      // Test valid
      await user.clear(slippageInput);
      await user.type(slippageInput, '5');
      await user.tab();
      expect(screen.queryByText(/Slippage must be/)).not.toBeInTheDocument();
    });

    it('should show validation errors on submit with empty form', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const submitButton = screen.getByTestId('campaign-submit-button');
      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText(/Title must be/)).toBeInTheDocument();
        expect(screen.getByText(/Description must be/)).toBeInTheDocument();
        expect(screen.getByText(/Budget must be/)).toBeInTheDocument();
      });
    });

    it('should show success indicator when field is valid', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const titleInput = screen.getByTestId('campaign-title-input');
      await user.type(titleInput, 'Valid Campaign Title');
      await user.tab();

      // Check for success indicator (green checkmark)
      const successIcon = titleInput.parentElement?.querySelector('svg');
      expect(successIcon).toBeInTheDocument();
    });
  });

  describe('Duration Handling', () => {
    it('should convert duration units correctly', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const durationInput = screen.getByTestId('campaign-duration-value-input');
      const unitSelect = screen.getByTestId('campaign-duration-unit-select');

      // Set 1 day
      await user.type(durationInput, '1');
      expect(screen.getByText(/Duration: 1d/)).toBeInTheDocument();

      // Change to hours
      await user.selectOptions(unitSelect, 'hours');
      expect(screen.getByText(/Duration: 1h/)).toBeInTheDocument();

      // Change to weeks
      await user.selectOptions(unitSelect, 'weeks');
      expect(screen.getByText(/Duration: 1w/)).toBeInTheDocument();
    });

    it('should display formatted duration', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const durationInput = screen.getByTestId('campaign-duration-value-input');
      const unitSelect = screen.getByTestId('campaign-duration-unit-select');

      // Set 2 days and 3 hours
      await user.clear(durationInput);
      await user.type(durationInput, '2.125');
      await user.selectOptions(unitSelect, 'days');

      expect(screen.getByText(/Duration: 2d 3h/)).toBeInTheDocument();
    });
  });

  describe('Form Submission', () => {
    it('should enable submit button when form is valid', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const titleInput = screen.getByTestId('campaign-title-input');
      const descriptionInput = screen.getByTestId('campaign-description-input');
      const budgetInput = screen.getByTestId('campaign-budget-input');
      const submitButton = screen.getByTestId('campaign-submit-button');

      await user.type(titleInput, 'Valid Campaign Title');
      await user.type(descriptionInput, 'This is a valid campaign description');
      await user.type(budgetInput, '1000');

      await waitFor(() => {
        expect(submitButton).not.toBeDisabled();
      });
    });

    it('should show confirmation dialog on submit', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      // Fill form
      await user.type(screen.getByTestId('campaign-title-input'), 'Test Campaign');
      await user.type(screen.getByTestId('campaign-description-input'), 'Test description for campaign');
      await user.type(screen.getByTestId('campaign-budget-input'), '500');

      // Submit
      await user.click(screen.getByTestId('campaign-submit-button'));

      await waitFor(() => {
        expect(screen.getByTestId('campaign-confirm-dialog')).toBeInTheDocument();
      });
    });

    it('should call onSuccess callback on successful submission', async () => {
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} onSuccess={onSuccess} />);

      // Fill form
      await user.type(screen.getByTestId('campaign-title-input'), 'Test Campaign');
      await user.type(screen.getByTestId('campaign-description-input'), 'Test description for campaign');
      await user.type(screen.getByTestId('campaign-budget-input'), '500');

      // Submit
      await user.click(screen.getByTestId('campaign-submit-button'));

      // Confirm
      await waitFor(() => {
        const confirmButton = screen.getByText('Create Campaign');
        expect(confirmButton).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should display error alert when submission fails', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn().mockRejectedValueOnce(new Error('Network error')),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'error',
        error: { code: 'NETWORK_ERROR', message: 'Network error occurred' },
        result: null,
        transactionState: null,
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/Campaign Creation Failed/)).toBeInTheDocument();
      });
    });

    it('should call onError callback on submission error', async () => {
      const onError = vi.fn();
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn().mockRejectedValueOnce(new Error('Test error')),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'error',
        error: { code: 'TRANSACTION_FAILED', message: 'Test error' },
        result: null,
        transactionState: null,
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} onError={onError} />);

      await waitFor(() => {
        expect(onError).toHaveBeenCalled();
      });
    });

    it('should show wallet connection warning when not connected', () => {
      const { useWallet } = require('../../hooks/useWallet');
      vi.mocked(useWallet).mockReturnValueOnce({
        wallet: {
          connected: false,
          address: null,
          network: 'testnet',
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnecting: false,
        error: null,
      });

      render(<CampaignCreationFormProduction {...defaultProps} />);

      expect(screen.getByText(/Wallet Required/)).toBeInTheDocument();
    });
  });

  describe('Loading States', () => {
    it('should disable form during submission', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn(),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'submitting',
        error: null,
        result: null,
        transactionState: null,
        isLoading: true,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      expect(screen.getByTestId('campaign-title-input')).toBeDisabled();
      expect(screen.getByTestId('campaign-description-input')).toBeDisabled();
      expect(screen.getByTestId('campaign-budget-input')).toBeDisabled();
    });

    it('should show loading state on submit button', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn(),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'submitting',
        error: null,
        result: null,
        transactionState: null,
        isLoading: true,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      const submitButton = screen.getByTestId('campaign-submit-button');
      expect(submitButton).toHaveAttribute('disabled');
      expect(screen.getByText(/Creating Campaign/)).toBeInTheDocument();
    });
  });

  describe('Success Modal', () => {
    it('should display success modal after successful submission', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn().mockResolvedValueOnce({
          campaignId: 'campaign_abc123',
          transactionHash: 'a'.repeat(64),
          timestamp: Date.now(),
          totalCost: '0.6',
        }),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'success',
        error: null,
        result: {
          campaignId: 'campaign_abc123',
          transactionHash: 'a'.repeat(64),
          timestamp: Date.now(),
          totalCost: '0.6',
        },
        transactionState: { hash: 'a'.repeat(64), status: 'success', timestamp: Date.now() },
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('campaign-success-modal')).toBeInTheDocument();
        expect(screen.getByText(/Campaign Created Successfully/)).toBeInTheDocument();
      });
    });

    it('should display campaign ID and transaction hash in success modal', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      const campaignId = 'campaign_abc123';
      const txHash = 'a'.repeat(64);

      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn(),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'success',
        error: null,
        result: {
          campaignId,
          transactionHash: txHash,
          timestamp: Date.now(),
          totalCost: '0.6',
        },
        transactionState: { hash: txHash, status: 'success', timestamp: Date.now() },
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(campaignId)).toBeInTheDocument();
        expect(screen.getByText(txHash)).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper labels for all inputs', () => {
      render(<CampaignCreationFormProduction {...defaultProps} />);

      expect(screen.getByLabelText(/Campaign Title/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Campaign Description/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Campaign Budget/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Campaign Duration/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Slippage Tolerance/)).toBeInTheDocument();
    });

    it('should have proper ARIA roles', () => {
      render(<CampaignCreationFormProduction {...defaultProps} />);

      expect(screen.getByTestId('campaign-creation-form')).toHaveAttribute('role', 'form');
    });

    it('should announce errors to screen readers', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const titleInput = screen.getByTestId('campaign-title-input');
      await user.type(titleInput, 'ab');
      await user.tab();

      const errorMessage = screen.getByText(/Title must be/);
      expect(errorMessage).toHaveClass('text-red-600');
    });
  });
});
