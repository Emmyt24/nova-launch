import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { CampaignCreationFormProduction } from './CampaignCreationFormProduction';
import type { CampaignCreationResult, CampaignTransactionState } from '../../types/campaign';
import type { AppError } from '../../types';

// Mock dependencies
vi.mock('../../hooks/useWallet', () => ({
  useWallet: vi.fn(() => ({
    wallet: {
      connected: true,
      address: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
      network: 'testnet',
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnecting: false,
    error: null,
  })),
}));

vi.mock('../../hooks/useCampaignCreation', () => ({
  useCampaignCreation: vi.fn(() => ({
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
  })),
}));

describe('CampaignCreationForm - Integration Tests', () => {
  const defaultProps = {
    tokenAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Complete Campaign Creation Flow', () => {
    it('should complete full campaign creation workflow', async () => {
      const onSuccess = vi.fn();
      const user = userEvent.setup();

      render(
        <CampaignCreationFormProduction
          {...defaultProps}
          onSuccess={onSuccess}
        />
      );

      // Fill form
      await user.type(
        screen.getByTestId('campaign-title-input'),
        'Summer Token Promotion'
      );
      await user.type(
        screen.getByTestId('campaign-description-input'),
        'This is a comprehensive campaign description for our summer token promotion event'
      );
      await user.type(
        screen.getByTestId('campaign-budget-input'),
        '5000.5'
      );
      await user.type(
        screen.getByTestId('campaign-slippage-input'),
        '2.5'
      );

      // Submit form
      const submitButton = screen.getByTestId('campaign-submit-button');
      await user.click(submitButton);

      // Confirm in dialog
      await waitFor(() => {
        expect(screen.getByTestId('campaign-confirm-dialog')).toBeInTheDocument();
      });

      const confirmButton = screen.getByText('Create Campaign');
      await user.click(confirmButton);

      // Verify success
      await waitFor(() => {
        expect(screen.getByTestId('campaign-success-modal')).toBeInTheDocument();
        expect(screen.getByText(/Campaign Created Successfully/)).toBeInTheDocument();
      });

      expect(onSuccess).toHaveBeenCalledWith(
        'campaign_abc123',
        'a'.repeat(64)
      );
    });

    it('should handle validation errors and allow correction', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      // Try to submit empty form
      await user.click(screen.getByTestId('campaign-submit-button'));

      // Verify validation errors
      await waitFor(() => {
        expect(screen.getByText(/Title must be/)).toBeInTheDocument();
        expect(screen.getByText(/Description must be/)).toBeInTheDocument();
        expect(screen.getByText(/Budget must be/)).toBeInTheDocument();
      });

      // Fix errors
      await user.type(
        screen.getByTestId('campaign-title-input'),
        'Valid Campaign'
      );
      await user.type(
        screen.getByTestId('campaign-description-input'),
        'This is a valid campaign description with enough content'
      );
      await user.type(
        screen.getByTestId('campaign-budget-input'),
        '1000'
      );

      // Verify errors cleared
      await waitFor(() => {
        expect(screen.queryByText(/Title must be/)).not.toBeInTheDocument();
      });

      // Submit should now work
      const submitButton = screen.getByTestId('campaign-submit-button');
      expect(submitButton).not.toBeDisabled();
    });
  });

  describe('Validation Edge Cases', () => {
    it('should handle maximum length inputs', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const titleInput = screen.getByTestId('campaign-title-input') as HTMLInputElement;
      const maxTitle = 'A'.repeat(100);

      await user.type(titleInput, maxTitle);
      expect(titleInput.value).toBe(maxTitle);

      // Try to exceed max length
      await user.type(titleInput, 'X');
      expect(titleInput.value).toBe(maxTitle); // Should not exceed
    });

    it('should handle decimal precision for budget', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const budgetInput = screen.getByTestId('campaign-budget-input');

      // Test 7 decimal places (stroops)
      await user.type(budgetInput, '1000.1234567');
      await user.tab();

      expect(screen.queryByText(/Budget must be/)).not.toBeInTheDocument();
    });

    it('should validate slippage with 2 decimal precision', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const slippageInput = screen.getByTestId('campaign-slippage-input');

      // Valid: 2 decimals
      await user.type(slippageInput, '5.25');
      await user.tab();
      expect(screen.queryByText(/Slippage must be/)).not.toBeInTheDocument();
    });

    it('should handle duration boundary values', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const durationInput = screen.getByTestId('campaign-duration-value-input');
      const unitSelect = screen.getByTestId('campaign-duration-unit-select');

      // Minimum: 1 hour
      await user.clear(durationInput);
      await user.type(durationInput, '1');
      await user.selectOptions(unitSelect, 'hours');
      await user.tab();
      expect(screen.queryByText(/Duration must be/)).not.toBeInTheDocument();

      // Maximum: 52 weeks (1 year)
      await user.clear(durationInput);
      await user.type(durationInput, '52');
      await user.selectOptions(unitSelect, 'weeks');
      await user.tab();
      expect(screen.queryByText(/Duration must be/)).not.toBeInTheDocument();
    });
  });

  describe('Error Recovery', () => {
    it('should allow retry after network error', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      const mockCreateCampaign = vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          campaignId: 'campaign_retry',
          transactionHash: 'b'.repeat(64),
          timestamp: Date.now(),
          totalCost: '0.6',
        });

      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: mockCreateCampaign,
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'error',
        error: { code: 'NETWORK_ERROR', message: 'Network error occurred' } as AppError,
        result: null,
        transactionState: null,
        isLoading: false,
      } as any);

      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      // Fill and submit
      await user.type(
        screen.getByTestId('campaign-title-input'),
        'Test Campaign'
      );
      await user.type(
        screen.getByTestId('campaign-description-input'),
        'Test description for campaign'
      );
      await user.type(
        screen.getByTestId('campaign-budget-input'),
        '500'
      );

      await user.click(screen.getByTestId('campaign-submit-button'));

      // Verify error displayed
      await waitFor(() => {
        expect(screen.getByText(/Campaign Creation Failed/)).toBeInTheDocument();
      });

      // Click retry
      const retryButton = screen.getByText('Try Again');
      await user.click(retryButton);

      // Form should be ready for resubmission
      expect(screen.getByTestId('campaign-submit-button')).not.toBeDisabled();
    });

    it('should display contract error with user-friendly message', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn(),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'error',
        error: {
          code: 'CONTRACT_ERROR',
          message: 'Insufficient balance for campaign budget',
          details: 'error: 2',
        } as AppError,
        result: null,
        transactionState: null,
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/Campaign Creation Failed/)).toBeInTheDocument();
        expect(screen.getByText(/Insufficient balance/)).toBeInTheDocument();
      });
    });
  });

  describe('Transaction Monitoring', () => {
    it('should display transaction status during submission', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn(),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'submitting',
        error: null,
        result: null,
        transactionState: {
          hash: 'a'.repeat(64),
          status: 'pending',
          timestamp: Date.now(),
        } as CampaignTransactionState,
        isLoading: true,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      // Form should be disabled
      expect(screen.getByTestId('campaign-title-input')).toBeDisabled();
      expect(screen.getByTestId('campaign-submit-button')).toBeDisabled();
    });

    it('should handle transaction timeout', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn(),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'error',
        error: {
          code: 'TIMEOUT_ERROR',
          message: 'Transaction confirmation timeout',
        } as AppError,
        result: null,
        transactionState: {
          hash: 'a'.repeat(64),
          status: 'timeout',
          timestamp: Date.now(),
          error: 'Transaction monitoring timeout',
        } as CampaignTransactionState,
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/Campaign Creation Failed/)).toBeInTheDocument();
        expect(screen.getByText(/Transaction confirmation timeout/)).toBeInTheDocument();
      });
    });
  });

  describe('Wallet Integration', () => {
    it('should show wallet connection warning when disconnected', () => {
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
      expect(screen.getByTestId('campaign-submit-button')).toBeDisabled();
    });

    it('should disable form when wallet is connecting', () => {
      const { useWallet } = require('../../hooks/useWallet');
      vi.mocked(useWallet).mockReturnValueOnce({
        wallet: {
          connected: false,
          address: null,
          network: 'testnet',
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnecting: true,
        error: null,
      });

      render(<CampaignCreationFormProduction {...defaultProps} />);

      expect(screen.getByTestId('campaign-title-input')).toBeDisabled();
      expect(screen.getByTestId('campaign-submit-button')).toBeDisabled();
    });

    it('should update form when network changes', async () => {
      const { useWallet } = require('../../hooks/useWallet');
      const { rerender } = render(
        <CampaignCreationFormProduction {...defaultProps} />
      );

      // Simulate network change
      vi.mocked(useWallet).mockReturnValueOnce({
        wallet: {
          connected: true,
          address: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
          network: 'mainnet',
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnecting: false,
        error: null,
      });

      rerender(<CampaignCreationFormProduction {...defaultProps} />);

      // Form should still be functional
      expect(screen.getByTestId('campaign-title-input')).not.toBeDisabled();
    });
  });

  describe('Fee Display', () => {
    it('should display accurate fee breakdown', () => {
      render(<CampaignCreationFormProduction {...defaultProps} />);

      const feeSection = screen.getByText('Fee Breakdown').closest('div');
      expect(within(feeSection!).getByText('0.5 XLM')).toBeInTheDocument(); // Base fee
      expect(within(feeSection!).getByText('0.1 XLM')).toBeInTheDocument(); // Gas fee
      expect(within(feeSection!).getByText('0.6 XLM')).toBeInTheDocument(); // Total
    });

    it('should show fees in confirmation dialog', async () => {
      const user = userEvent.setup();
      render(<CampaignCreationFormProduction {...defaultProps} />);

      // Fill and submit
      await user.type(
        screen.getByTestId('campaign-title-input'),
        'Test Campaign'
      );
      await user.type(
        screen.getByTestId('campaign-description-input'),
        'Test description for campaign'
      );
      await user.type(
        screen.getByTestId('campaign-budget-input'),
        '500'
      );

      await user.click(screen.getByTestId('campaign-submit-button'));

      await waitFor(() => {
        const dialog = screen.getByTestId('campaign-confirm-dialog');
        expect(within(dialog).getByText(/Base Fee/)).toBeInTheDocument();
        expect(within(dialog).getByText(/Estimated Gas/)).toBeInTheDocument();
      });
    });
  });

  describe('Success Modal Details', () => {
    it('should display campaign ID and transaction hash', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      const campaignId = 'campaign_test123';
      const txHash = 'b'.repeat(64);

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
        } as CampaignCreationResult,
        transactionState: {
          hash: txHash,
          status: 'success',
          timestamp: Date.now(),
        } as CampaignTransactionState,
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(campaignId)).toBeInTheDocument();
        expect(screen.getByText(txHash)).toBeInTheDocument();
      });
    });

    it('should allow copying campaign details', async () => {
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn(),
        reset: vi.fn(),
        cleanup: vi.fn(),
        status: 'success',
        error: null,
        result: {
          campaignId: 'campaign_copy_test',
          transactionHash: 'c'.repeat(64),
          timestamp: Date.now(),
          totalCost: '0.6',
        } as CampaignCreationResult,
        transactionState: {
          hash: 'c'.repeat(64),
          status: 'success',
          timestamp: Date.now(),
        } as CampaignTransactionState,
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      await waitFor(() => {
        const modal = screen.getByTestId('campaign-success-modal');
        expect(within(modal).getByText('campaign_copy_test')).toBeInTheDocument();
      });
    });
  });

  describe('Form Reset', () => {
    it('should reset form after successful submission', async () => {
      const user = userEvent.setup();
      const { useCampaignCreation } = await import('../../hooks/useCampaignCreation');
      const mockReset = vi.fn();

      vi.mocked(useCampaignCreation).mockReturnValueOnce({
        createCampaign: vi.fn().mockResolvedValueOnce({
          campaignId: 'campaign_reset_test',
          transactionHash: 'd'.repeat(64),
          timestamp: Date.now(),
          totalCost: '0.6',
        }),
        reset: mockReset,
        cleanup: vi.fn(),
        status: 'success',
        error: null,
        result: {
          campaignId: 'campaign_reset_test',
          transactionHash: 'd'.repeat(64),
          timestamp: Date.now(),
          totalCost: '0.6',
        } as CampaignCreationResult,
        transactionState: {
          hash: 'd'.repeat(64),
          status: 'success',
          timestamp: Date.now(),
        } as CampaignTransactionState,
        isLoading: false,
      } as any);

      render(<CampaignCreationFormProduction {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('campaign-success-modal')).toBeInTheDocument();
      });

      const doneButton = screen.getByText('Done');
      await user.click(doneButton);

      // Verify reset was called
      expect(mockReset).toHaveBeenCalled();
    });
  });
});
