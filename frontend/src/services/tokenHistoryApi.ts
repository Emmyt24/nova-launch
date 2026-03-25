/**
 * Token History API Client
 *
 * Provides methods to fetch token deployment history from the backend.
 * Serves as the source of truth for confirmed token deployments.
 *
 * @deprecated Use tokenSearchApi.ts for new code - provides full filter support
 */

import type { TokenInfo } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

/**
 * Applied filters echoed back from backend
 */
export interface AppliedFilters {
  q?: string;
  creator?: string;
  startDate?: string;
  endDate?: string;
  minSupply?: string;
  maxSupply?: string;
  hasBurns?: string;
  sortBy: 'created' | 'burned' | 'supply' | 'name';
  sortOrder: 'asc' | 'desc';
}

export interface TokenHistoryResponse {
  success: boolean;
  data: BackendTokenInfo[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  filters?: AppliedFilters;
  cached?: boolean;
}

export interface BackendTokenInfo {
  id: string;
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  initialSupply: string;
  totalBurned: string;
  burnCount: number;
  metadataUri?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FetchTokenHistoryOptions {
  /** Full-text search by name or symbol */
  q?: string;
  /** Filter by creator address */
  creator?: string;
  /** Filter tokens created on or after this date (ISO datetime) */
  startDate?: string;
  /** Filter tokens created on or before this date (ISO datetime) */
  endDate?: string;
  /** Minimum total supply (as string for BigInt) */
  minSupply?: string;
  /** Maximum total supply (as string for BigInt) */
  maxSupply?: string;
  /** Filter by burn status */
  hasBurns?: 'true' | 'false';
  /** Sort field */
  sortBy?: 'created' | 'burned' | 'supply' | 'name';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Page number */
  page?: number;
  /** Results per page */
  limit?: number;
}

/**
 * Fetch token deployment history for a specific creator from the backend
 */
export async function fetchTokenHistory(
  options: FetchTokenHistoryOptions = {}
): Promise<TokenHistoryResponse> {
  const {
    q,
    creator,
    startDate,
    endDate,
    minSupply,
    maxSupply,
    hasBurns,
    page = 1,
    limit = 50,
    sortBy = 'created',
    sortOrder = 'desc',
  } = options;

  const params = new URLSearchParams();

  if (q) params.append('q', q);
  if (creator) params.append('creator', creator);
  if (startDate) params.append('startDate', startDate);
  if (endDate) params.append('endDate', endDate);
  if (minSupply) params.append('minSupply', minSupply);
  if (maxSupply) params.append('maxSupply', maxSupply);
  if (hasBurns) params.append('hasBurns', hasBurns);
  params.append('sortBy', sortBy);
  params.append('sortOrder', sortOrder);
  params.append('page', page.toString());
  params.append('limit', Math.min(limit, 50).toString());

  const url = `${API_BASE_URL}/tokens/search?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: TokenHistoryResponse = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to fetch token history:', error);
    throw error;
  }
}

/**
 * Convert backend token info to frontend TokenInfo format
 */
export function convertBackendToken(backendToken: BackendTokenInfo): TokenInfo {
  return {
    address: backendToken.address,
    name: backendToken.name,
    symbol: backendToken.symbol,
    decimals: backendToken.decimals,
    totalSupply: backendToken.totalSupply,
    creator: backendToken.creator,
    metadataUri: backendToken.metadataUri || undefined,
    deployedAt: new Date(backendToken.createdAt).getTime(),
    transactionHash: '', // Backend doesn't store this yet, will be empty
  };
}

/**
 * Fetch a single token by address
 */
export async function fetchTokenByAddress(address: string): Promise<BackendTokenInfo | null> {
  const url = `${API_BASE_URL}/tokens/search?q=${encodeURIComponent(address)}&limit=1`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const data: TokenHistoryResponse = await response.json();
    if (data.success && data.data.length > 0) {
      return data.data[0];
    }
    return null;
  } catch (error) {
    console.error('Failed to fetch token by address:', error);
    return null;
  }
}
