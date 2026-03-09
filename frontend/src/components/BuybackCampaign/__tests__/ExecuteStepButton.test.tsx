import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExecuteStepButton } from '../ExecuteStepButton';
import * as useStellarHook from '../../../hooks/useStellar';
import * as useWalletHook from '../../../hooks/useWallet';

vi.mock('../../../hooks/useStellar');
vi.mock('../../../hooks/useWallet');

describe('ExecuteStepButton', () => {
  const mockExecuteBuybackStep = vi.fn();
  const mockWallet = {
    address: 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    isConnected: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useStellarHook.useStellar).mockReturnValue({
      executeBuybackStep: mockExecuteBuybackStep,
      getCampaign: vi.fn(),
    });
    vi.mocked(useWalletHook.useWallet).mockReturnValue({
      wallet: mockWallet,
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnecting: false,
      error: null,
    });
  });

  describe('Button State Management', () => {
    it('should render with correct initial state', () => {
      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button', { name: /execute step 1/i });
      expect(button).toBeInTheDocument();
      expect(button).not.toBeDisabled();
    });

    it('should disable button when wallet is not connected', () => {
      vi.mocked(useWalletHook.useWallet).mockReturnValue({
        wallet: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnecting: false,
        error: null,
      });

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('should disable button when campaign is not active', () => {
      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="COMPLETED"
        />
      );

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('should disable button when campaign is cancelled', () => {
      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="CANCELLED"
        />
      );

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });
  });

  describe('Transaction Execution', () => {
    it('should execute step successfully', async () => {
      const mockTxHash = 'abc123def456';
      mockExecuteBuybackStep.mockResolvedValue({ txHash: mockTxHash });

      const onSuccess = vi.fn();

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
          onSuccess={onSuccess}
        />
      );

      const button = screen.getByRole('button', { name: /execute step 1/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText(/executing/i)).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByText(/transaction successful/i)).toBeInTheDocument();
      });

      expect(mockExecuteBuybackStep).toHaveBeenCalledWith(1, mockWallet.address);
      expect(onSuccess).toHaveBeenCalledWith(mockTxHash);
    });

    it('should show pending state during execution', async () => {
      mockExecuteBuybackStep.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText(/executing/i)).toBeInTheDocument();
        expect(screen.getByText(/processing transaction/i)).toBeInTheDocument();
      });
    });

    it('should handle transaction failure', async () => {
      const errorMessage = 'Insufficient balance';
      mockExecuteBuybackStep.mockRejectedValue(new Error(errorMessage));

      const onError = vi.fn();

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
          onError={onError}
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText(/transaction failed/i)).toBeInTheDocument();
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
      });

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should allow retry after failure', async () => {
      mockExecuteBuybackStep
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ txHash: 'retry123' });

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText(/transaction failed/i)).toBeInTheDocument();
      });

      const retryButton = screen.getByRole('button', { name: /retry/i });
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(screen.getByText(/transaction successful/i)).toBeInTheDocument();
      });

      expect(mockExecuteBuybackStep).toHaveBeenCalledTimes(2);
    });
  });

  describe('Transaction Feedback', () => {
    it('should display transaction hash link on success', async () => {
      const mockTxHash = 'abc123def456';
      mockExecuteBuybackStep.mockResolvedValue({ txHash: mockTxHash });

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        const link = screen.getByRole('link', { name: /view on stellar expert/i });
        expect(link).toHaveAttribute(
          'href',
          `https://stellar.expert/explorer/testnet/tx/${mockTxHash}`
        );
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      });
    });

    it('should show campaign status message when not active', () => {
      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="COMPLETED"
        />
      );

      expect(
        screen.getByText(/campaign is completed. cannot execute steps/i)
      ).toBeInTheDocument();
    });
  });

  describe('Wallet Connection Handling', () => {
    it('should handle wallet disconnection during execution', async () => {
      mockExecuteBuybackStep.mockRejectedValue(new Error('Wallet not connected'));

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText(/wallet not connected/i)).toBeInTheDocument();
      });
    });

    it('should not execute when wallet is null', () => {
      vi.mocked(useWalletHook.useWallet).mockReturnValue({
        wallet: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnecting: false,
        error: null,
      });

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(mockExecuteBuybackStep).not.toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    it('should have proper aria-label', () => {
      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={2}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button', {
        name: 'Execute buyback step 3',
      });
      expect(button).toBeInTheDocument();
    });

    it('should be keyboard accessible', async () => {
      mockExecuteBuybackStep.mockResolvedValue({ txHash: 'test123' });

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      button.focus();
      expect(button).toHaveFocus();

      fireEvent.keyDown(button, { key: 'Enter' });

      await waitFor(() => {
        expect(mockExecuteBuybackStep).toHaveBeenCalled();
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty transaction hash', async () => {
      mockExecuteBuybackStep.mockResolvedValue({ txHash: '' });

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText(/transaction successful/i)).toBeInTheDocument();
      });
    });

    it('should handle very long error messages', async () => {
      const longError = 'A'.repeat(500);
      mockExecuteBuybackStep.mockRejectedValue(new Error(longError));

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText(longError)).toBeInTheDocument();
      });
    });

    it('should prevent double execution', async () => {
      mockExecuteBuybackStep.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ txHash: 'test' }), 100))
      );

      render(
        <ExecuteStepButton
          campaignId={1}
          currentStep={0}
          stepAmount="1000"
          status="ACTIVE"
        />
      );

      const button = screen.getByRole('button');
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByText(/transaction successful/i)).toBeInTheDocument();
      });

      expect(mockExecuteBuybackStep).toHaveBeenCalledTimes(1);
    });
  });
});
