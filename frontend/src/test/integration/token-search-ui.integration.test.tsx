/**
 * Integration tests for token search UI
 *
 * Tests the frontend discovery screens connected to backend token search API.
 * Verifies search, filters, pagination, and proper handling of indexed data.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenList } from '../../components/TransactionHistory/TokenList';
import { TokenCard, type IndexedTokenCardData } from '../../components/TransactionHistory/TokenCard';
import {
  formatTokenSupply,
  formatCompactNumber,
  calculateBurnPercentage,
  formatBurnStats,
} from '../../utils/formatting';
import type { BackendTokenInfo, TokenSearchResponse } from '../../services/tokenSearchApi';
import type { WalletState } from '../../types';

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => ({
    wallet: {
      connected: true,
      address: 'GTEST_WALLET_ADDRESS_123456789',
      network: 'testnet' as const,
    },
  }),
}));

vi.mock('../../services/TransactionHistoryStorage', () => ({
  transactionHistoryStorage: {
    getTokens: vi.fn(() => []),
    addToken: vi.fn(),
    clearAll: vi.fn(),
  },
}));

globalThis.fetch = vi.fn() as any;

const mockWallet: WalletState = {
  connected: true,
  address: 'GTEST_WALLET_ADDRESS_123456789',
  network: 'testnet',
};

const mockDisconnectedWallet: WalletState = {
  connected: false,
  address: null,
  network: 'testnet',
};

function createMockBackendToken(overrides: Partial<BackendTokenInfo> = {}): BackendTokenInfo {
  const id = Math.random().toString(36).substring(7);
  return {
    id: `uuid-${id}`,
    address: `CTOKEN${id.toUpperCase()}`,
    creator: 'GTEST_WALLET_ADDRESS_123456789',
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 7,
    totalSupply: '10000000000000',
    initialSupply: '10000000000000',
    totalBurned: '0',
    burnCount: 0,
    metadataUri: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockSearchResponse(
  tokens: BackendTokenInfo[],
  pagination: Partial<TokenSearchResponse['pagination']> = {}
): TokenSearchResponse {
  return {
    success: true,
    data: tokens,
    pagination: {
      page: 1,
      limit: 20,
      total: tokens.length,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
      ...pagination,
    },
    filters: {
      sortBy: 'created',
      sortOrder: 'desc',
    },
  };
}

describe('Token Search UI Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis.fetch as any).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('BigInt String Handling', () => {
    it('should format large token supplies correctly', () => {
      expect(formatTokenSupply('1000000000000000', 7)).toBe('100,000,000');
      expect(formatTokenSupply('10000000', 7)).toBe('1');
      expect(formatTokenSupply('15000000', 7)).toBe('1.5');
      expect(formatTokenSupply('0', 7)).toBe('0');
    });

    it('should format supplies in compact notation', () => {
      expect(formatCompactNumber(1500000)).toBe('1.50M');
      expect(formatCompactNumber(2300000000)).toBe('2.30B');
      expect(formatCompactNumber(500)).toBe('500');
      expect(formatCompactNumber(1200)).toBe('1.20K');
    });

    it('should calculate burn percentage correctly', () => {
      expect(calculateBurnPercentage('1000000', '10000000')).toBe(10);
      expect(calculateBurnPercentage('5000000', '10000000')).toBe(50);
      expect(calculateBurnPercentage('0', '10000000')).toBe(0);
      expect(calculateBurnPercentage('10000000', '10000000')).toBe(100);
    });

    it('should format burn stats with proper decimals', () => {
      const stats = formatBurnStats('1234567890000', 5, '10000000000000', 7);
      expect(stats.burnedAmount).toBeDefined();
      expect(stats.burnCount).toBe('5');
      expect(stats.percentage).toMatch(/^\d+\.\d{2}%$/);
    });

    it('should handle edge cases in BigInt formatting', () => {
      expect(formatTokenSupply('', 7)).toBe('0');
      expect(calculateBurnPercentage('100', '0')).toBe(0);
      expect(formatBurnStats('0', 0, '1000000', 7).percentage).toBe('0.00%');
    });
  });

  describe('TokenCard Component', () => {
    it('should render token with indexed metadata', () => {
      const token: IndexedTokenCardData = {
        address: 'CTOKEN123456789',
        name: 'Nova Token',
        symbol: 'NOVA',
        decimals: 7,
        totalSupply: '10000000000000',
        initialSupply: '10000000000000',
        totalBurned: '1000000000000',
        burnCount: 15,
        creator: 'GCREATOR123',
        deployedAt: Date.now() - 86400000,
        transactionHash: '',
      };

      render(<TokenCard token={token} network="testnet" />);

      expect(screen.getByText('Nova Token')).toBeInTheDocument();
      expect(screen.getByText('NOVA')).toBeInTheDocument();
      expect(screen.getByText(/Supply:/)).toBeInTheDocument();
      expect(screen.getByText(/Burned:/)).toBeInTheDocument();
    });

    it('should hide burn stats when no burns', () => {
      const token: IndexedTokenCardData = {
        address: 'CTOKEN_NO_BURNS',
        name: 'Fresh Token',
        symbol: 'FRESH',
        decimals: 7,
        totalSupply: '10000000000000',
        initialSupply: '10000000000000',
        totalBurned: '0',
        burnCount: 0,
        creator: 'GCREATOR123',
        deployedAt: Date.now(),
        transactionHash: 'tx123',
      };

      render(<TokenCard token={token} network="testnet" />);

      expect(screen.getByText('Fresh Token')).toBeInTheDocument();
      expect(screen.queryByText(/Burned:/)).not.toBeInTheDocument();
    });

    it('should hide View TX button when no transaction hash', () => {
      const token: IndexedTokenCardData = {
        address: 'CTOKEN_NO_TX',
        name: 'No TX Token',
        symbol: 'NTX',
        decimals: 7,
        totalSupply: '10000000000000',
        creator: 'GCREATOR123',
        deployedAt: Date.now(),
        transactionHash: '',
      };

      render(<TokenCard token={token} network="testnet" />);

      expect(screen.getByText('View Token')).toBeInTheDocument();
      expect(screen.queryByText('View TX')).not.toBeInTheDocument();
    });

    it('should show View TX button when transaction hash exists', () => {
      const token: IndexedTokenCardData = {
        address: 'CTOKEN_WITH_TX',
        name: 'TX Token',
        symbol: 'TXT',
        decimals: 7,
        totalSupply: '10000000000000',
        creator: 'GCREATOR123',
        deployedAt: Date.now(),
        transactionHash: 'abc123txhash',
      };

      render(<TokenCard token={token} network="testnet" />);

      expect(screen.getByText('View Token')).toBeInTheDocument();
      expect(screen.getByText('View TX')).toBeInTheDocument();
    });

    it('should use correct explorer URLs for testnet', () => {
      const token: IndexedTokenCardData = {
        address: 'CTESTNET_TOKEN',
        name: 'Testnet Token',
        symbol: 'TST',
        decimals: 7,
        totalSupply: '10000000000000',
        creator: 'GCREATOR123',
        deployedAt: Date.now(),
        transactionHash: 'txhash123',
      };

      render(<TokenCard token={token} network="testnet" />);

      const viewTokenButton = screen.getByText('View Token');
      fireEvent.click(viewTokenButton);
    });

    it('should handle copy address functionality', async () => {
      const user = userEvent.setup();
      const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
      Object.assign(navigator, { clipboard: mockClipboard });

      const token: IndexedTokenCardData = {
        address: 'CTOKEN_COPY_TEST',
        name: 'Copy Test',
        symbol: 'CPY',
        decimals: 7,
        totalSupply: '10000000000000',
        creator: 'GCREATOR123',
        deployedAt: Date.now(),
        transactionHash: '',
      };

      render(<TokenCard token={token} network="testnet" />);

      const copyButton = screen.getByTitle('Copy address');
      await user.click(copyButton);

      expect(mockClipboard.writeText).toHaveBeenCalledWith('CTOKEN_COPY_TEST');
    });
  });

  describe('TokenList Search', () => {
    it('should render search input', async () => {
      const mockResponse = createMockSearchResponse([]);
      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search by name or symbol...')).toBeInTheDocument();
      });
    });

    it('should call search API with query parameter', async () => {
      const user = userEvent.setup();
      const token = createMockBackendToken({ name: 'Searched Token', symbol: 'SRCH' });
      const mockResponse = createMockSearchResponse([token]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search by name or symbol...')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search by name or symbol...');
      await user.type(searchInput, 'nova');

      const searchButton = screen.getByText('Search');
      await user.click(searchButton);

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          expect.stringContaining('q=nova'),
          expect.any(Object)
        );
      });
    });

    it('should clear search and reset results', async () => {
      const user = userEvent.setup();
      const token = createMockBackendToken({ name: 'Test Token' });
      const mockResponse = createMockSearchResponse([token]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search by name or symbol...')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search by name or symbol...');
      await user.type(searchInput, 'test');
      await user.click(screen.getByText('Search'));

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalled();
      });
    });
  });

  describe('TokenList Filters', () => {
    it('should show filter panel when clicking Filters button', async () => {
      const user = userEvent.setup();
      const mockResponse = createMockSearchResponse([]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByText('Filters')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Filters'));

      await waitFor(() => {
        expect(screen.getByText('Sort by:')).toBeInTheDocument();
        expect(screen.getByText('Burn status:')).toBeInTheDocument();
      });
    });

    it('should filter by burn status', async () => {
      const user = userEvent.setup();
      const tokenWithBurns = createMockBackendToken({
        name: 'Burned Token',
        totalBurned: '1000000',
        burnCount: 5,
      });
      const mockResponse = createMockSearchResponse([tokenWithBurns]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByText('Filters')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Filters'));

      await waitFor(() => {
        expect(screen.getByText('Burn status:')).toBeInTheDocument();
      });

      const burnSelect = screen.getByRole('combobox', { name: '' });
      const burnStatusSelect = Array.from(
        document.querySelectorAll('select')
      ).find((select) => select.options[0]?.text === 'All tokens');

      if (burnStatusSelect) {
        await user.selectOptions(burnStatusSelect, 'true');

        await waitFor(() => {
          expect(globalThis.fetch).toHaveBeenCalledWith(
            expect.stringContaining('hasBurns=true'),
            expect.any(Object)
          );
        });
      }
    });

    it('should change sort order', async () => {
      const user = userEvent.setup();
      const mockResponse = createMockSearchResponse([]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByText('Filters')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Filters'));

      await waitFor(() => {
        expect(screen.getByText('Sort by:')).toBeInTheDocument();
      });

      const sortSelect = Array.from(document.querySelectorAll('select')).find(
        (select) => select.options[0]?.text === 'Date Created'
      );

      if (sortSelect) {
        await user.selectOptions(sortSelect, 'supply');

        await waitFor(() => {
          expect(globalThis.fetch).toHaveBeenCalledWith(
            expect.stringContaining('sortBy=supply'),
            expect.any(Object)
          );
        });
      }
    });
  });

  describe('TokenList Pagination', () => {
    it('should show pagination controls when multiple pages exist', async () => {
      const tokens = Array.from({ length: 5 }, (_, i) =>
        createMockBackendToken({ name: `Token ${i + 1}` })
      );
      const mockResponse = createMockSearchResponse(tokens, {
        page: 1,
        limit: 20,
        total: 50,
        totalPages: 3,
        hasNext: true,
        hasPrev: false,
      });

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
        expect(screen.getByText('Previous')).toBeInTheDocument();
        expect(screen.getByText('Next')).toBeInTheDocument();
      });
    });

    it('should disable Previous button on first page', async () => {
      const tokens = [createMockBackendToken()];
      const mockResponse = createMockSearchResponse(tokens, {
        page: 1,
        totalPages: 3,
        hasNext: true,
        hasPrev: false,
      });

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        const prevButton = screen.getByText('Previous');
        expect(prevButton).toBeDisabled();
      });
    });

    it('should disable Next button on last page', async () => {
      const tokens = [createMockBackendToken()];
      const mockResponse = createMockSearchResponse(tokens, {
        page: 3,
        totalPages: 3,
        hasNext: false,
        hasPrev: true,
      });

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        const nextButton = screen.getByText('Next');
        expect(nextButton).toBeDisabled();
      });
    });

    it('should fetch next page when clicking Next', async () => {
      const user = userEvent.setup();
      const tokens = [createMockBackendToken()];
      const mockResponse = createMockSearchResponse(tokens, {
        page: 1,
        totalPages: 3,
        hasNext: true,
        hasPrev: false,
      });

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByText('Next')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Next'));

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          expect.stringContaining('page=2'),
          expect.any(Object)
        );
      });
    });
  });

  describe('Loading and Error States', () => {
    it('should show loading skeleton on initial load', () => {
      (globalThis.fetch as any).mockImplementation(
        () => new Promise(() => {})
      );

      render(<TokenList wallet={mockWallet} />);

      expect(screen.getByText('Your Tokens')).toBeInTheDocument();
    });

    it('should show error message when API fails', async () => {
      (globalThis.fetch as any).mockRejectedValue(new Error('Network error'));

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByText(/Failed to sync with backend/)).toBeInTheDocument();
      });
    });

    it('should show empty state when no tokens found', async () => {
      const mockResponse = createMockSearchResponse([]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(
          screen.getByText(/No tokens match your filters|Deploy your first token/i)
        ).toBeInTheDocument();
      });
    });

    it('should show wallet not connected state', () => {
      render(<TokenList wallet={mockDisconnectedWallet} />);

      expect(screen.getByText(/Connect your wallet/i)).toBeInTheDocument();
    });
  });

  describe('Creator Filter', () => {
    it('should filter tokens by connected wallet address', async () => {
      const token = createMockBackendToken({
        creator: mockWallet.address!,
      });
      const mockResponse = createMockSearchResponse([token]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          expect.stringContaining(`creator=${mockWallet.address}`),
          expect.any(Object)
        );
      });
    });
  });

  describe('Pending Token Display', () => {
    it('should display pending badge for unconfirmed tokens', async () => {
      const token = createMockBackendToken({ name: 'Confirmed Token' });
      const mockResponse = createMockSearchResponse([token]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByText('Confirmed Token')).toBeInTheDocument();
      });
    });
  });

  describe('Refresh Functionality', () => {
    it('should refresh data when clicking Refresh button', async () => {
      const user = userEvent.setup();
      const token = createMockBackendToken({ name: 'Token' });
      const mockResponse = createMockSearchResponse([token]);

      (globalThis.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      render(<TokenList wallet={mockWallet} />);

      await waitFor(() => {
        expect(screen.getByText('Refresh')).toBeInTheDocument();
      });

      const initialCallCount = (globalThis.fetch as any).mock.calls.length;

      await user.click(screen.getByText('Refresh'));

      await waitFor(() => {
        expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThan(
          initialCallCount
        );
      });
    });
  });
});
