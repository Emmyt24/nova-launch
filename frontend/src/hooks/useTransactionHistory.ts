import { useState, useEffect, useMemo, useCallback } from 'react';
import { useWallet } from './useWallet';
import type { TokenInfo } from '../types';
import { transactionHistoryStorage } from '../services/TransactionHistoryStorage';
import {
  fetchTokenHistory,
  convertBackendToken,
  type FetchTokenHistoryOptions,
  type BackendTokenInfo,
} from '../services/tokenHistoryApi';

export interface Transaction {
  id: string;
  tokenName: string;
  tokenSymbol: string;
  contractAddress: string;
  timestamp: number;
  walletAddress: string;
}

/**
 * Extended token info with indexed backend metadata
 */
export interface IndexedTokenInfo extends TokenInfo {
  initialSupply?: string;
  totalBurned?: string;
  burnCount?: number;
  isPending?: boolean;
}

/**
 * Pagination state for token history
 */
export interface PaginationState {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Filter options for token history
 */
export interface TokenHistoryFilters {
  q?: string;
  startDate?: string;
  endDate?: string;
  minSupply?: string;
  maxSupply?: string;
  hasBurns?: 'true' | 'false';
  sortBy?: 'created' | 'burned' | 'supply' | 'name';
  sortOrder?: 'asc' | 'desc';
}

interface UseTransactionHistoryReturn {
  history: IndexedTokenInfo[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  refreshFromBackend: () => Promise<void>;
  isRefreshing: boolean;
  pagination: PaginationState;
  filters: TokenHistoryFilters;
  setFilters: (filters: TokenHistoryFilters) => void;
  setPage: (page: number) => void;
  search: (query: string) => void;
}

const DEFAULT_PAGINATION: PaginationState = {
  page: 1,
  limit: 20,
  total: 0,
  totalPages: 0,
  hasNext: false,
  hasPrev: false,
};

const DEFAULT_FILTERS: TokenHistoryFilters = {
  sortBy: 'created',
  sortOrder: 'desc',
};

/**
 * Convert backend token to IndexedTokenInfo with full metadata
 */
function convertToIndexedToken(backendToken: BackendTokenInfo): IndexedTokenInfo {
  return {
    ...convertBackendToken(backendToken),
    initialSupply: backendToken.initialSupply,
    totalBurned: backendToken.totalBurned,
    burnCount: backendToken.burnCount,
    isPending: false,
  };
}

/**
 * Hook for managing token deployment history with backend synchronization
 *
 * Features:
 * - Loads optimistic local records immediately
 * - Syncs with backend on mount and wallet change
 * - Deduplicates records by token address
 * - Treats backend as source of truth after confirmation
 * - Preserves pending optimistic entries
 * - Full search, filter, and pagination support
 */
export const useTransactionHistory = (): UseTransactionHistoryReturn => {
  const { wallet } = useWallet();
  const address = wallet.address;

  const [localHistory, setLocalHistory] = useState<TokenInfo[]>([]);
  const [backendHistory, setBackendHistory] = useState<IndexedTokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginationState>(DEFAULT_PAGINATION);
  const [filters, setFilters] = useState<TokenHistoryFilters>(DEFAULT_FILTERS);

  // Load local history immediately for optimistic UI
  useEffect(() => {
    if (!address) {
      setLocalHistory([]);
      setLoading(false);
      return;
    }

    try {
      const tokens = transactionHistoryStorage.getTokens(address);
      setLocalHistory(tokens);
    } catch (err) {
      console.error('Failed to load local history:', err);
      setError('Failed to load local history');
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Fetch from backend on mount and when address/filters/page changes
  const refreshFromBackend = useCallback(async () => {
    if (!address) {
      setBackendHistory([]);
      setPagination(DEFAULT_PAGINATION);
      return;
    }

    setIsRefreshing(true);
    setError(null);

    try {
      const options: FetchTokenHistoryOptions = {
        creator: address,
        page: pagination.page,
        limit: pagination.limit,
        ...filters,
      };

      const response = await fetchTokenHistory(options);

      if (response.success) {
        const convertedTokens = response.data.map(convertToIndexedToken);
        setBackendHistory(convertedTokens);

        setPagination({
          page: response.pagination.page,
          limit: response.pagination.limit,
          total: response.pagination.total,
          totalPages: response.pagination.totalPages,
          hasNext: response.pagination.hasNext,
          hasPrev: response.pagination.hasPrev,
        });

        // Reconcile: Update local storage with backend data (only on first page without search)
        if (pagination.page === 1 && !filters.q) {
          const basicTokens = convertedTokens.map((t) => ({
            address: t.address,
            name: t.name,
            symbol: t.symbol,
            decimals: t.decimals,
            totalSupply: t.totalSupply,
            creator: t.creator,
            metadataUri: t.metadataUri,
            deployedAt: t.deployedAt,
            transactionHash: t.transactionHash,
          }));
          reconcileWithBackend(address, basicTokens);
        }
      }
    } catch (err) {
      console.error('Failed to fetch backend history:', err);
      setError('Failed to sync with backend');
    } finally {
      setIsRefreshing(false);
    }
  }, [address, pagination.page, pagination.limit, filters]);

  // Auto-refresh from backend on mount and when dependencies change
  useEffect(() => {
    refreshFromBackend();
  }, [refreshFromBackend]);

  // Helper to set page
  const setPage = useCallback((page: number) => {
    setPagination((prev) => ({ ...prev, page }));
  }, []);

  // Helper for search
  const search = useCallback((query: string) => {
    setFilters((prev) => ({ ...prev, q: query || undefined }));
    setPagination((prev) => ({ ...prev, page: 1 }));
  }, []);

  // Update filters and reset to page 1
  const updateFilters = useCallback((newFilters: TokenHistoryFilters) => {
    setFilters(newFilters);
    setPagination((prev) => ({ ...prev, page: 1 }));
  }, []);

  // Merge and deduplicate local and backend history
  const mergedHistory = useMemo(() => {
    if (!address) return [];

    // If we have active search/filters, only show backend results
    if (filters.q || filters.hasBurns || filters.minSupply || filters.maxSupply) {
      return backendHistory;
    }

    // Create a map to deduplicate by token address
    const tokenMap = new Map<string, IndexedTokenInfo>();

    // First, add backend tokens (source of truth)
    backendHistory.forEach((token) => {
      tokenMap.set(token.address, token);
    });

    // Then, add local tokens that aren't in backend yet (optimistic/pending)
    // Only on first page to avoid duplicates across pages
    if (pagination.page === 1) {
      localHistory.forEach((token) => {
        if (!tokenMap.has(token.address)) {
          tokenMap.set(token.address, {
            ...token,
            isPending: true,
          });
        }
      });
    }

    // Convert to array and sort by deployment time (newest first)
    return Array.from(tokenMap.values()).sort(
      (a, b) => b.deployedAt - a.deployedAt
    );
  }, [localHistory, backendHistory, address, filters, pagination.page]);

  return {
    history: mergedHistory,
    loading,
    error,
    isEmpty: mergedHistory.length === 0 && !loading,
    refreshFromBackend,
    isRefreshing,
    pagination,
    filters,
    setFilters: updateFilters,
    setPage,
    search,
  };
};

/**
 * Reconcile local storage with backend data
 * Updates local records with confirmed backend data
 */
function reconcileWithBackend(walletAddress: string, backendTokens: TokenInfo[]): void {
  try {
    const localTokens = transactionHistoryStorage.getTokens(walletAddress);
    
    // Update local tokens with backend data if they exist
    backendTokens.forEach(backendToken => {
      const localToken = localTokens.find(t => t.address === backendToken.address);
      
      if (localToken) {
        // Update existing local record with backend data (source of truth)
        transactionHistoryStorage.addToken(walletAddress, backendToken);
      } else {
        // Add new token from backend that wasn't in local storage
        transactionHistoryStorage.addToken(walletAddress, backendToken);
      }
    });
  } catch (err) {
    console.error('Failed to reconcile with backend:', err);
  }
}