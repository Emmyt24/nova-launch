import { useState, useCallback } from 'react';
import { Button, SkeletonList } from '../UI';
import { TokenCard } from './TokenCard';
import { NoTokensEmptyState, NoWalletEmptyState } from '../UI';
import { useTransactionHistory, type TokenHistoryFilters } from '../../hooks/useTransactionHistory';
import type { WalletState } from '../../types';

interface TokenListProps {
  wallet: WalletState;
}

type SortOption = {
  value: TokenHistoryFilters['sortBy'];
  label: string;
};

const SORT_OPTIONS: SortOption[] = [
  { value: 'created', label: 'Date Created' },
  { value: 'name', label: 'Name' },
  { value: 'supply', label: 'Total Supply' },
  { value: 'burned', label: 'Total Burned' },
];

export function TokenList({ wallet }: TokenListProps) {
  const {
    history,
    loading,
    error,
    isEmpty,
    refreshFromBackend,
    isRefreshing,
    pagination,
    filters,
    setFilters,
    setPage,
    search,
  } = useTransactionHistory();

  const [searchInput, setSearchInput] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      search(searchInput);
    },
    [search, searchInput]
  );

  const handleClearSearch = useCallback(() => {
    setSearchInput('');
    search('');
  }, [search]);

  const handleSortChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const sortBy = e.target.value as TokenHistoryFilters['sortBy'];
      setFilters({ ...filters, sortBy });
    },
    [filters, setFilters]
  );

  const handleSortOrderToggle = useCallback(() => {
    setFilters({
      ...filters,
      sortOrder: filters.sortOrder === 'desc' ? 'asc' : 'desc',
    });
  }, [filters, setFilters]);

  const handleBurnFilterChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      setFilters({
        ...filters,
        hasBurns: value === 'all' ? undefined : (value as 'true' | 'false'),
      });
    },
    [filters, setFilters]
  );

  if (!wallet.connected) {
    return <NoWalletEmptyState />;
  }

  if (loading && history.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-bold text-gray-900">Your Tokens</h2>
        </div>
        <SkeletonList count={3} variant="card" />
      </div>
    );
  }

  const hasActiveFilters = filters.q || filters.hasBurns;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-bold text-gray-900">
            Your Tokens
            {pagination.total > 0 && (
              <span className="text-lg font-normal text-gray-500 ml-2">
                ({pagination.total})
              </span>
            )}
          </h2>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
            >
              {showFilters ? 'Hide Filters' : 'Filters'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshFromBackend}
              loading={isRefreshing}
            >
              Refresh
            </Button>
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name or symbol..."
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {filters.q && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            )}
          </div>
          <Button type="submit" variant="primary" size="sm">
            Search
          </Button>
        </form>

        {showFilters && (
          <div className="flex flex-wrap gap-4 p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600">Sort by:</label>
              <select
                value={filters.sortBy || 'created'}
                onChange={handleSortChange}
                className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleSortOrderToggle}
                className="p-1.5 border border-gray-300 rounded-md hover:bg-gray-100"
                title={filters.sortOrder === 'desc' ? 'Descending' : 'Ascending'}
              >
                {filters.sortOrder === 'desc' ? '↓' : '↑'}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600">Burn status:</label>
              <select
                value={filters.hasBurns || 'all'}
                onChange={handleBurnFilterChange}
                className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All tokens</option>
                <option value="true">Has burns</option>
                <option value="false">No burns</option>
              </select>
            </div>

            {hasActiveFilters && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchInput('');
                  setFilters({ sortBy: 'created', sortOrder: 'desc' });
                }}
              >
                Clear Filters
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-sm text-yellow-800">
            {error} - Showing local data only
          </p>
        </div>
      )}

      {isEmpty && !loading ? (
        hasActiveFilters ? (
          <div className="text-center py-12">
            <p className="text-gray-500 mb-4">No tokens match your filters</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearchInput('');
                setFilters({ sortBy: 'created', sortOrder: 'desc' });
              }}
            >
              Clear Filters
            </Button>
          </div>
        ) : (
          <NoTokensEmptyState />
        )
      ) : (
        <>
          {isRefreshing && (
            <div className="text-center py-2">
              <span className="text-sm text-gray-500">Updating...</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {history.map((token) => (
              <div key={token.address} className="relative">
                {token.isPending && (
                  <div className="absolute -top-2 -right-2 z-10">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                      Pending
                    </span>
                  </div>
                )}
                <TokenCard token={token} network={wallet.network} />
              </div>
            ))}
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex justify-center items-center gap-4 pt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(pagination.page - 1)}
                disabled={!pagination.hasPrev || isRefreshing}
              >
                Previous
              </Button>
              <span className="text-sm text-gray-600">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(pagination.page + 1)}
                disabled={!pagination.hasNext || isRefreshing}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
