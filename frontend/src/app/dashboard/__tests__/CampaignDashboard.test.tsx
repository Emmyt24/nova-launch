import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CampaignDashboard from '../CampaignDashboard';

const mockFetcher = async () => ({
  updatedAt: 1_700_000_000_000,
  campaigns: [
    {
      id: 'campaign-1',
      name: 'Campaign One',
      status: 'active' as const,
      metrics: {
        spent: 400,
        bought: 360,
        burned: 300,
        budget: 1000,
      },
      timeline: [
        {
          id: 'lc-created',
          timestamp: 1000,
          category: 'lifecycle' as const,
          action: 'Campaign created',
          details: 'Created by admin.',
        },
        {
          id: 'lc-activated',
          timestamp: 3000,
          category: 'lifecycle' as const,
          action: 'Campaign activated',
          details: 'Now running.',
        },
        {
          id: 'step-2-quote',
          timestamp: 2000,
          category: 'execution' as const,
          step: 2,
          action: 'Quote accepted',
          details: 'Good price.',
        },
        {
          id: 'step-2-buy',
          timestamp: 2500,
          category: 'execution' as const,
          step: 2,
          action: 'Buyback executed',
          details: 'Spent from treasury.',
        },
      ],
    },
  ],
});

describe('CampaignDashboard', () => {
  it('renders spent, bought, burned, remaining budget, and status metrics', async () => {
    render(<CampaignDashboard fetchCampaigns={mockFetcher} pollIntervalMs={60000} staleAfterMs={120000} />);

    expect(await screen.findByText('Campaign One')).toBeInTheDocument();
    expect(screen.getByTestId('metric-spent-campaign-1')).toHaveTextContent('400');
    expect(screen.getByTestId('metric-bought-campaign-1')).toHaveTextContent('360');
    expect(screen.getByTestId('metric-burned-campaign-1')).toHaveTextContent('300');
    expect(screen.getByTestId('metric-remaining-campaign-1')).toHaveTextContent('600');
    expect(screen.getByTestId('metric-status-campaign-1')).toHaveTextContent('active');
  });

  it('groups timeline by lifecycle and execution step with newest-first ordering', async () => {
    const { container } = render(
      <CampaignDashboard fetchCampaigns={mockFetcher} pollIntervalMs={60000} staleAfterMs={120000} />,
    );

    expect(await screen.findByText('Lifecycle Actions')).toBeInTheDocument();
    expect(screen.getByText('Execution Steps')).toBeInTheDocument();
    expect(screen.getByText('Step 2')).toBeInTheDocument();

    const lifecycleItems = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="timeline-lifecycle-campaign-1-"]'),
    );
    expect(lifecycleItems).toHaveLength(2);
    expect(lifecycleItems[0]).toHaveTextContent('Campaign activated');
    expect(lifecycleItems[1]).toHaveTextContent('Campaign created');

    const stepItems = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="timeline-step-campaign-1-2-"]'),
    );
    expect(stepItems).toHaveLength(2);
    expect(stepItems[0]).toHaveTextContent('Buyback executed');
    expect(stepItems[1]).toHaveTextContent('Quote accepted');
  });
});
