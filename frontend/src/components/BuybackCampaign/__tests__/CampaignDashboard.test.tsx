import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CampaignDashboard } from '../CampaignDashboard';

global.fetch = vi.fn();

describe('CampaignDashboard Integration Tests', () => {
  const mockCampaign = {
    id: 1,
    tokenAddress: 'GTEST123456789',
    totalAmount: '10000',
    executedAmount: '5000',
    currentStep: 2,
    totalSteps: 5,
    status: 'ACTIVE' as const,
    createdAt: '2026-03-09T10:00:00Z',
    steps: [
      {
        id: 1,
        stepNumber: 0,
        amount: '2000',
        status: 'COMPLETED' as const,
        executedAt: '2026-03-09T10:30:00Z',
        txHash: 'hash1',
      },
      {
        id: 2,
        stepNumber: 1,
        amount: '3000',
        status: 'COMPLETED' as const,
        executedAt: '2026-03-09T11:00:00Z',
        txHash: 'hash2',
      },
      {
        id: 3,
        stepNumber: 2,
        amount: '2000',
        status: 'PENDING' as const,
      },
      {
        id: 4,
        stepNumber: 3,
        amount: '1500',
        status: 'PENDING' as const,
      },
      {
        id: 5,
        stepNumber: 4,
        amount: '1500',
        status: 'PENDING' as const,
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch and display campaign data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText(/buyback campaign #1/i)).toBeInTheDocument();
    });

    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText(mockCampaign.tokenAddress)).toBeInTheDocument();
    expect(screen.getByText('2 / 5 steps')).toBeInTheDocument();
  });

  it('should show loading state initially', () => {
    vi.mocked(fetch).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(<CampaignDashboard campaignId={1} />);

    expect(screen.getByRole('status', { hidden: true })).toBeInTheDocument();
  });

  it('should handle fetch errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText(/failed to fetch campaign/i)).toBeInTheDocument();
    });
  });

  it('should display progress bar correctly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      const progressText = screen.getByText('40%');
      expect(progressText).toBeInTheDocument();
    });
  });

  it('should show all steps with correct status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getAllByText('COMPLETED')).toHaveLength(2);
      expect(screen.getAllByText('PENDING')).toHaveLength(3);
    });
  });

  it('should highlight current step', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText('(Current)')).toBeInTheDocument();
    });
  });

  it('should not show execute button for completed campaign', async () => {
    const completedCampaign = {
      ...mockCampaign,
      status: 'COMPLETED' as const,
      currentStep: 5,
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => completedCampaign,
    } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /execute/i })).not.toBeInTheDocument();
    });
  });

  it('should refresh data after successful step execution', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockCampaign,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockCampaign,
          currentStep: 3,
          executedAmount: '7000',
        }),
      } as Response);

    render(<CampaignDashboard campaignId={1} />);

    await waitFor(() => {
      expect(screen.getByText('2 / 5 steps')).toBeInTheDocument();
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
