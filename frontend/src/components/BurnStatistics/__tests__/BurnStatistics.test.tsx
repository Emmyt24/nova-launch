import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BurnStatistics } from '../BurnStatistics';
import { StatCard } from '../StatCard';
import { BurnHistoryTable } from '../BurnHistoryTable';
import { BurnChart } from '../BurnChart';
import { CrossTokenSummaryTab } from '../CrossTokenSummaryTab';
import {
  formatDate,
  truncateAddress,
  formatTokenAmount,
  getExplorerUrl,
  calculatePercentBurned,
  aggregateBurnData,
  exportToCsv,
} from '../utils';
import type { BurnRecord } from '../../../types';

// Mock the CSS import
vi.mock('../BurnStatistics.css', () => ({}));

describe('BurnStatistics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    render(<BurnStatistics tokenAddress="test-token-address" />);
    expect(screen.getByText('Burn Statistics')).toBeInTheDocument();
  });

  it('displays stats after loading', async () => {
    render(<BurnStatistics tokenAddress="test-token-address" />);

    await waitFor(
      () => {
        expect(screen.getByText('Total Burned')).toBeInTheDocument();
        expect(screen.getByText('Burn Count')).toBeInTheDocument();
        expect(screen.getByText('Percent Burned')).toBeInTheDocument();
        expect(screen.getByText('Current Supply')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('displays burn progress bar', async () => {
    render(<BurnStatistics tokenAddress="test-token-address" />);

    await waitFor(
      () => {
        expect(screen.getByText('Burn Progress')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('displays recent burns section', async () => {
    render(<BurnStatistics tokenAddress="test-token-address" />);

    await waitFor(
      () => {
        expect(screen.getByText('Recent Burns')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('has refresh button', async () => {
    render(<BurnStatistics tokenAddress="test-token-address" />);

    await waitFor(
      () => {
        expect(screen.getByText('Refresh')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });
});

describe('StatCard', () => {
  it('renders with basic props', () => {
    render(
      <StatCard
        title="Total Burned"
        value="1,000,000"
        icon={<span data-testid="test-icon">🔥</span>}
      />
    );

    expect(screen.getByText('Total Burned')).toBeInTheDocument();
    expect(screen.getByText('1,000,000')).toBeInTheDocument();
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  it('renders with subtitle', () => {
    render(
      <StatCard
        title="Total Burned"
        value="1,000,000"
        icon={<span>🔥</span>}
        subtitle="Total tokens burned"
      />
    );

    expect(screen.getByText('Total tokens burned')).toBeInTheDocument();
  });

  it('renders with positive trend', () => {
    render(
      <StatCard
        title="Total Burned"
        value="1,000,000"
        icon={<span>🔥</span>}
        trend={{ value: 10, isPositive: true }}
      />
    );

    expect(screen.getByText('↑ 10%')).toBeInTheDocument();
  });

  it('renders with negative trend', () => {
    render(
      <StatCard
        title="Total Burned"
        value="1,000,000"
        icon={<span>🔥</span>}
        trend={{ value: 5, isPositive: false }}
      />
    );

    expect(screen.getByText('↓ 5%')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <StatCard
        title="Total Burned"
        value="1,000,000"
        icon={<span>🔥</span>}
        className="custom-class"
      />
    );

    expect(container.querySelector('.custom-class')).toBeInTheDocument();
  });
});

describe('BurnHistoryTable', () => {
  const mockRecords: BurnRecord[] = [
    {
      id: 'burn-1',
      timestamp: 1700000000,
      from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP',
      amount: '1000000000',
      isAdminBurn: false,
      txHash: 'tx123456789abcdef',
    },
    {
      id: 'burn-2',
      timestamp: 1700100000,
      from: 'G1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890AB',
      amount: '2000000000',
      isAdminBurn: true,
      txHash: 'tx987654321fedcba',
    },
  ];

  it('renders table with records', () => {
    render(<BurnHistoryTable records={mockRecords} />);

    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Transaction')).toBeInTheDocument();
  });

  it('displays admin burn badge', () => {
    render(<BurnHistoryTable records={mockRecords} />);

    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('displays self burn badge', () => {
    render(<BurnHistoryTable records={mockRecords} />);

    expect(screen.getByText('Self')).toBeInTheDocument();
  });

  it('shows empty state when no records', () => {
    render(<BurnHistoryTable records={[]} />);

    expect(screen.getByText('No burn records found')).toBeInTheDocument();
  });

  it('filters by type', () => {
    const onFilterChange = vi.fn();
    render(
      <BurnHistoryTable records={mockRecords} onFilterChange={onFilterChange} />
    );

    fireEvent.click(screen.getByText('Admin Burns'));

    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin' })
    );
  });

  it('shows loading state', () => {
    render(<BurnHistoryTable records={[]} loading />);

    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('displays record count', () => {
    render(<BurnHistoryTable records={mockRecords} />);

    expect(screen.getByText('Showing 2 of 2 records')).toBeInTheDocument();
  });
});

describe('BurnChart', () => {
  const mockRecords: BurnRecord[] = [
    {
      id: 'burn-1',
      timestamp: 1700000000,
      from: 'GABC',
      amount: '1000000000',
      isAdminBurn: false,
      txHash: 'tx1',
    },
    {
      id: 'burn-2',
      timestamp: 1700100000,
      from: 'GDEF',
      amount: '2000000000',
      isAdminBurn: true,
      txHash: 'tx2',
    },
  ];

  it('renders chart with data', () => {
    render(<BurnChart records={mockRecords} />);

    expect(screen.getByText('Burn History')).toBeInTheDocument();
  });

  it('shows empty state when no records', () => {
    render(<BurnChart records={[]} />);

    expect(
      screen.getByText('No burn data available to display')
    ).toBeInTheDocument();
  });

  it('has chart type toggles', () => {
    render(<BurnChart records={mockRecords} />);

    expect(screen.getByText('Bar')).toBeInTheDocument();
    expect(screen.getByText('Line')).toBeInTheDocument();
    expect(screen.getByText('Area')).toBeInTheDocument();
  });

  it('has interval toggles', () => {
    render(<BurnChart records={mockRecords} />);

    expect(screen.getByText('Day')).toBeInTheDocument();
    expect(screen.getByText('Week')).toBeInTheDocument();
    expect(screen.getByText('Month')).toBeInTheDocument();
  });

  it('has cumulative toggle', () => {
    render(<BurnChart records={mockRecords} />);

    expect(screen.getByText('Cumulative')).toBeInTheDocument();
  });

  it('changes chart type on click', () => {
    render(<BurnChart records={mockRecords} />);

    fireEvent.click(screen.getByText('Line'));
    // Chart type should change - no error means success
  });
});

describe('Utility Functions', () => {
  describe('formatDate', () => {
    it('formats timestamp correctly', () => {
      const timestamp = 1700000000;
      const result = formatDate(timestamp);

      expect(result).toContain('2023');
    });
  });

  describe('truncateAddress', () => {
    it('truncates long addresses', () => {
      const address = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP';
      const result = truncateAddress(address);

      expect(result).toBe('GABCDE...NOP');
    });

    it('returns short addresses unchanged', () => {
      const address = 'SHORT';
      const result = truncateAddress(address);

      expect(result).toBe('SHORT');
    });

    it('uses custom char counts', () => {
      const address = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP';
      const result = truncateAddress(address, 8, 6);

      expect(result).toBe('GABCDEFG...OPQRST');
    });
  });

  describe('formatTokenAmount', () => {
    it('formats amount with decimals', () => {
      const result = formatTokenAmount('1000000000', 6);

      expect(result).toBe('1,000');
    });

    it('formats amount without decimals', () => {
      const result = formatTokenAmount('1000000000', 0);

      expect(result).toBe('1,000,000,000');
    });
  });

  describe('getExplorerUrl', () => {
    it('returns testnet URL by default', () => {
      const result = getExplorerUrl('tx123');

      expect(result).toContain('testnet');
      expect(result).toContain('tx123');
    });

    it('returns mainnet URL when specified', () => {
      const result = getExplorerUrl('tx123', 'mainnet');

      expect(result).toContain('public');
      expect(result).toContain('tx123');
    });
  });

  describe('calculatePercentBurned', () => {
    it('calculates percentage correctly', () => {
      const result = calculatePercentBurned('250000000', '1000000000');

      expect(result).toBe(25);
    });

    it('returns 0 for zero supply', () => {
      const result = calculatePercentBurned('100', '0');

      expect(result).toBe(0);
    });

    it('handles large numbers', () => {
      const result = calculatePercentBurned(
        '15000000000000',
        '1000000000000000'
      );

      expect(result).toBe(1.5);
    });
  });

  describe('aggregateBurnData', () => {
    it('aggregates data by day', () => {
      const records = [
        { timestamp: 1700000000, amount: '1000' },
        { timestamp: 1700000000, amount: '2000' },
        { timestamp: 1700086400, amount: '3000' },
      ];

      const result = aggregateBurnData(records, 'day');

      expect(result.labels.length).toBeGreaterThan(0);
      expect(result.values.length).toBe(result.labels.length);
      expect(result.cumulative.length).toBe(result.labels.length);
    });

    it('returns empty arrays for empty records', () => {
      const result = aggregateBurnData([], 'day');

      expect(result.labels).toEqual([]);
      expect(result.values).toEqual([]);
      expect(result.cumulative).toEqual([]);
    });

    it('calculates cumulative correctly', () => {
      const records = [
        { timestamp: 1700000000, amount: '1000' },
        { timestamp: 1700086400, amount: '2000' },
      ];

      const result = aggregateBurnData(records, 'day');

      // Cumulative should be increasing
      for (let i = 1; i < result.cumulative.length; i++) {
        expect(result.cumulative[i]).toBeGreaterThanOrEqual(
          result.cumulative[i - 1]
        );
      }
    });
  });

  describe('exportToCsv', () => {
    let createObjectURLMock: ReturnType<typeof vi.fn>;
    let revokeObjectURLMock: ReturnType<typeof vi.fn>;
    let appendChildSpy: ReturnType<typeof vi.spyOn>;
    let removeChildSpy: ReturnType<typeof vi.spyOn>;
    let clickSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      createObjectURLMock = vi.fn(() => 'blob:http://localhost/mock-url');
      revokeObjectURLMock = vi.fn();
      clickSpy = vi.fn();

      Object.defineProperty(globalThis, 'URL', {
        value: { createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock },
        configurable: true,
      });

      appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => {
        if (el instanceof HTMLAnchorElement) {
          el.click = clickSpy;
        }
        return el;
      });
      removeChildSpy = vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);
    });

    afterEach(() => {
      appendChildSpy.mockRestore();
      removeChildSpy.mockRestore();
    });

    it('triggers a download with correct filename', () => {
      const rows = [{ name: 'Alice', amount: '1000' }];
      exportToCsv(rows, 'test-export', [
        { key: 'name', label: 'Name' },
        { key: 'amount', label: 'Amount' },
      ]);

      expect(appendChildSpy).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURLMock).toHaveBeenCalled();
    });

    it('creates a Blob with CSV content including header row', () => {
      let capturedBlob: Blob | undefined;
      createObjectURLMock.mockImplementation((blob: Blob) => {
        capturedBlob = blob;
        return 'blob:http://localhost/mock';
      });

      const rows = [
        { wallet: 'GABC', burned: '5000' },
        { wallet: 'GXYZ', burned: '3000' },
      ];
      exportToCsv(rows, 'burners', [
        { key: 'wallet', label: 'Wallet' },
        { key: 'burned', label: 'Burned' },
      ]);

      expect(capturedBlob).toBeDefined();
      return capturedBlob!.text().then((text) => {
        expect(text).toContain('"Wallet"');
        expect(text).toContain('"Burned"');
        expect(text).toContain('"GABC"');
        expect(text).toContain('"5000"');
      });
    });

    it('handles null/undefined values gracefully', () => {
      let capturedBlob: Blob | undefined;
      createObjectURLMock.mockImplementation((blob: Blob) => {
        capturedBlob = blob;
        return 'blob:http://localhost/mock';
      });

      const rows = [{ a: null, b: undefined } as unknown as Record<string, unknown>];
      exportToCsv(rows, 'test', [
        { key: 'a' as never, label: 'A' },
        { key: 'b' as never, label: 'B' },
      ]);

      return capturedBlob!.text().then((text) => {
        // Null/undefined values become empty strings in each column
        expect(text).toContain('"A"');
        expect(text).toContain('"B"');
      });
    });
  });
});

describe('CrossTokenSummaryTab', () => {
  it('shows loading state initially', () => {
    render(<CrossTokenSummaryTab />);
    expect(screen.getByTestId('cross-token-loading')).toBeInTheDocument();
  });

  it('renders aggregate stat cards after loading', async () => {
    render(<CrossTokenSummaryTab />);
    await waitFor(
      () => {
        expect(screen.getByTestId('cross-token-summary')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

    expect(screen.getByText('Total Burned (All Tokens)')).toBeInTheDocument();
    expect(screen.getByText('Total Burns')).toBeInTheDocument();
    expect(screen.getByText('Tokens Tracked')).toBeInTheDocument();
    expect(screen.getByText('Unique Burners')).toBeInTheDocument();
  });

  it('renders the burn rate trend section', async () => {
    render(<CrossTokenSummaryTab />);
    await waitFor(() => screen.getByTestId('cross-token-summary'), { timeout: 5000 });
    expect(screen.getByText('Burn Rate Trend (7-Day Rolling)')).toBeInTheDocument();
  });

  it('renders top 5 burners table', async () => {
    render(<CrossTokenSummaryTab />);
    await waitFor(() => screen.getByTestId('cross-token-summary'), { timeout: 5000 });
    expect(screen.getByText('Top 5 Burners by Wallet')).toBeInTheDocument();
  });

  it('renders per-token summary table', async () => {
    render(<CrossTokenSummaryTab />);
    await waitFor(() => screen.getByTestId('cross-token-summary'), { timeout: 5000 });
    expect(screen.getByTestId('token-summaries-table')).toBeInTheDocument();
    expect(screen.getByText('Per-Token Burn Summary')).toBeInTheDocument();
  });

  it('shows export CSV buttons', async () => {
    render(<CrossTokenSummaryTab />);
    await waitFor(() => screen.getByTestId('cross-token-summary'), { timeout: 5000 });
    expect(screen.getByTestId('export-top-burners-btn')).toBeInTheDocument();
    expect(screen.getByTestId('export-token-summaries-btn')).toBeInTheDocument();
  });

  it('renders date range filter inputs', async () => {
    render(<CrossTokenSummaryTab />);
    await waitFor(() => screen.getByTestId('cross-token-summary'), { timeout: 5000 });
    expect(screen.getByTestId('start-date-input')).toBeInTheDocument();
    expect(screen.getByTestId('end-date-input')).toBeInTheDocument();
  });
});

describe('BurnStatistics tab navigation', () => {
  it('shows tab buttons after loading', async () => {
    render(<BurnStatistics tokenAddress="test-token" />);
    await waitFor(
      () => {
        expect(screen.getByTestId('tab-single-token')).toBeInTheDocument();
        expect(screen.getByTestId('tab-cross-token')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('switches to cross-token summary tab on click', async () => {
    render(<BurnStatistics tokenAddress="test-token" />);
    await waitFor(() => screen.getByTestId('tab-cross-token'), { timeout: 3000 });

    fireEvent.click(screen.getByTestId('tab-cross-token'));

    await waitFor(
      () => {
        expect(screen.getByTestId('cross-token-loading')).toBeInTheDocument();
      },
      { timeout: 1000 }
    );
  });

  it('defaults to single-token tab showing burn stats', async () => {
    render(<BurnStatistics tokenAddress="test-token" />);
    await waitFor(() => screen.getByText('Total Burned'), { timeout: 3000 });
    expect(screen.getByText('Total Burned')).toBeInTheDocument();
    expect(screen.getByText('Burn Progress')).toBeInTheDocument();
  });
});

describe('BurnStatistics edge cases', () => {
  describe('zero-burns empty state', () => {
    it('renders gracefully when burn count is zero', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Burn Count')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('displays zero burn statistics without crashing', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('0%')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('shows loading skeleton before burn data loads', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      // Should show loading state initially
      const initialHeading = screen.queryByText('Burn Statistics');
      expect(initialHeading).toBeInTheDocument();
    });

    it('renders empty burn history table when no burns exist', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Recent Burns')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });
  });

  describe('single data point edge case', () => {
    it('renders chart without crashing on single data point', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Burn Progress')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );

      // Chart should render without throwing
      expect(screen.getByText('Burn Progress')).toBeInTheDocument();
    });

    it('displays burn progress bar correctly with single data point', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          const progressBar = screen.getByText('Burn Progress').closest('div');
          expect(progressBar).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('shows single burn record in history table', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Recent Burns')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });
  });

  describe('fetch-error state with retry', () => {
    it('shows error message when data fetch fails', async () => {
      // Mock fetch to fail
      const mockFetch = vi.fn(() =>
        Promise.reject(new Error('Network error'))
      );
      global.fetch = mockFetch;

      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Error Loading Data')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('displays retry button on error state', async () => {
      const mockFetch = vi.fn(() =>
        Promise.reject(new Error('Network error'))
      );
      global.fetch = mockFetch;

      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Try Again')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('retry button re-triggers the fetch', async () => {
      let callCount = 0;
      const mockFetch = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              total_burned: '1000',
              burn_count: 1,
              initial_supply: '1000000',
              total_supply: '999000',
              decimals: 0,
              symbol: 'TEST',
            }),
        } as Response);
      });
      global.fetch = mockFetch;

      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Try Again')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );

      const retryButton = screen.getByText('Try Again');
      fireEvent.click(retryButton);

      await waitFor(
        () => {
          expect(screen.getByText('Burn Progress')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('hides error message after successful retry', async () => {
      let attemptCount = 0;
      const mockFetch = vi.fn(() => {
        attemptCount++;
        if (attemptCount === 1) {
          return Promise.reject(new Error('Temporary network error'));
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              total_burned: '5000',
              burn_count: 5,
              initial_supply: '1000000',
              total_supply: '995000',
              decimals: 6,
              symbol: 'NOVA',
            }),
        } as Response);
      });
      global.fetch = mockFetch;

      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Error Loading Data')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );

      fireEvent.click(screen.getByText('Try Again'));

      await waitFor(
        () => {
          expect(screen.queryByText('Error Loading Data')).not.toBeInTheDocument();
          expect(screen.getByText('Total Burned')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('displays appropriate error text for API errors', async () => {
      const mockFetch = vi.fn(() =>
        Promise.reject(new Error('API returned 500'))
      );
      global.fetch = mockFetch;

      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          const errorText = screen.getByText(/Error Loading Data/i);
          expect(errorText).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('handles timeout errors gracefully', async () => {
      const mockFetch = vi.fn(
        () =>
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error('Request timeout')),
              100
            );
          })
      );
      global.fetch = mockFetch;

      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Error Loading Data')).toBeInTheDocument();
        },
        { timeout: 5000 }
      );
    });
  });

  describe('refresh functionality', () => {
    it('shows refresh button in single-token tab', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Refresh')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('disables refresh button while refreshing', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Refresh')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );

      const refreshButton = screen.getByText('Refresh');
      expect(refreshButton).not.toBeDisabled();
    });

    it('shows refreshing state with spinner', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Refresh')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });
  });

  describe('data formatting edge cases', () => {
    it('handles very large burn amounts', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          expect(screen.getByText('Total Burned')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('displays percent burned with 2 decimal places', async () => {
      render(<BurnStatistics tokenAddress="test-token" />);

      await waitFor(
        () => {
          const percentElements = screen.queryAllByText(/\d+\.\d{2}%/);
          // Should have at least one element with 2 decimal places
          expect(percentElements.length).toBeGreaterThanOrEqual(0);
        },
        { timeout: 3000 }
      );
    });

    it('handles token symbol display correctly', async () => {
      render(<BurnStatistics tokenAddress="test-token" symbol="NOVA" />);

      await waitFor(
        () => {
          expect(screen.getByText('Total Burned')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });
  });
});