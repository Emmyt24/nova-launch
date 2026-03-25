/**
 * Token Search API Client
 *
 * Provides typed methods to search and discover tokens from the backend.
 * Serves as the canonical source for indexed contract state.
 */

import type { TokenInfo } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

/**
 * Backend token data structure (matches Prisma Token model)
 * BigInt fields are serialized as strings
 */
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

/**
 * Pagination metadata from backend response
 */
export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Filter state echoed back from backend
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

/**
 * Token search API response shape
 */
export interface TokenSearchResponse {
  success: boolean;
  data: BackendTokenInfo[];
  pagination: PaginationInfo;
  filters: AppliedFilters;
  cached?: boolean;
}

/**
 * Error response shape from backend
 */
export interface TokenSearchError {
  success: false;
  error: string;
  message?: string;
  details?: Array<{ path: string[]; message: string }>;
}

/**
 * Full set of search options matching backend API
 */
export interface TokenSearchOptions {
  /** Full-text search by name or symbol */
  q?: string;
  /** Filter by creator address (exact match) */
  creator?: string;
  /** Filter tokens created on or after this date (ISO datetime) */
  startDate?: string;
  /** Filter tokens created on or before this date (ISO datetime) */
  endDate?: string;
  /** Minimum total supply (as string for BigInt) */
  minSupply?: string;
  /** Maximum total supply (as string for BigInt) */
  maxSupply?: string;
  /** Filter by burn status: 'true' for tokens with burns, 'false' for no burns */
  hasBurns?: 'true' | 'false';
  /** Sort field */
  sortBy?: 'created' | 'burned' | 'supply' | 'name';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Page number (1-indexed) */
  page?: number;
  /** Results per page (max 50) */
  limit?: number;
}

/**
 * Extended TokenInfo with indexed metadata from backend
 */
export interface IndexedTokenInfo extends TokenInfo {
  id: string;
  initialSupply: string;
  totalBurned: string;
  burnCount: number;
  updatedAt: number;
}

/**
 * Search tokens with full filter support
 *
 * @example
 * // Search by name
 * const result = await searchTokens({ q: 'Nova' });
 *
 * // Filter by creator with pagination
 * const result = await searchTokens({ creator: 'G...', page: 1, limit: 20 });
 *
 * // Find tokens with burns, sorted by burn amount
 * const result = await searchTokens({ hasBurns: 'true', sortBy: 'burned', sortOrder: 'desc' });
 */
export async function searchTokens(
  options: TokenSearchOptions = {}
): Promise<TokenSearchResponse> {
  const {
    q,
    creator,
    startDate,
    endDate,
    minSupply,
    maxSupply,
    hasBurns,
    sortBy = 'created',
    sortOrder = 'desc',
    page = 1,
    limit = 20,
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

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorData: TokenSearchError = await response.json().catch(() => ({
      success: false as const,
      error: `HTTP error ${response.status}`,
    }));
    throw new TokenSearchApiError(
      errorData.message || errorData.error,
      response.status,
      errorData.details
    );
  }

  return response.json();
}

/**
 * Search for a single token by contract address
 */
export async function searchTokenByAddress(
  address: string
): Promise<BackendTokenInfo | null> {
  try {
    const response = await searchTokens({ q: address, limit: 10 });

    if (response.success && response.data.length > 0) {
      const exactMatch = response.data.find(
        (token) => token.address.toLowerCase() === address.toLowerCase()
      );
      return exactMatch || null;
    }
    return null;
  } catch (error) {
    console.error('Failed to search token by address:', error);
    return null;
  }
}

/**
 * Convert backend token to IndexedTokenInfo format
 */
export function convertToIndexedToken(backend: BackendTokenInfo): IndexedTokenInfo {
  return {
    id: backend.id,
    address: backend.address,
    name: backend.name,
    symbol: backend.symbol,
    decimals: backend.decimals,
    totalSupply: backend.totalSupply,
    initialSupply: backend.initialSupply,
    totalBurned: backend.totalBurned,
    burnCount: backend.burnCount,
    creator: backend.creator,
    metadataUri: backend.metadataUri || undefined,
    deployedAt: new Date(backend.createdAt).getTime(),
    updatedAt: new Date(backend.updatedAt).getTime(),
    transactionHash: '',
  };
}

/**
 * Convert backend token to basic TokenInfo format (for compatibility)
 */
export function convertToTokenInfo(backend: BackendTokenInfo): TokenInfo {
  return {
    address: backend.address,
    name: backend.name,
    symbol: backend.symbol,
    decimals: backend.decimals,
    totalSupply: backend.totalSupply,
    creator: backend.creator,
    metadataUri: backend.metadataUri || undefined,
    deployedAt: new Date(backend.createdAt).getTime(),
    transactionHash: '',
  };
}

/**
 * Custom error class for token search API errors
 */
export class TokenSearchApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: Array<{ path: string[]; message: string }>
  ) {
    super(message);
    this.name = 'TokenSearchApiError';
  }
}

/**
 * Type guard to check if error is a TokenSearchApiError
 */
export function isTokenSearchApiError(error: unknown): error is TokenSearchApiError {
  return error instanceof TokenSearchApiError;
}
