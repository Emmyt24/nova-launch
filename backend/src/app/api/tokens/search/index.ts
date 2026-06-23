/**
 * Token Search and Discovery API
 *
 * This module provides comprehensive search and filtering capabilities
 * for discovering tokens with full-text search, multiple filters,
 * sorting options, and pagination.
 */

export { GET } from "./route";
export { searchTokensSchema } from "./schema";
export { buildTokenSearchQuery } from "./query-builder";
export {
  getCachedSearchResults,
  cacheSearchResults,
  clearSearchCache,
  recordQueryFrequency,
  getTopQueryTerms,
  invalidateTagsForToken,
} from "./cache";
export { executeTokenSearch } from "./searchTokens";

export type { SearchTokensQuery, ValidatedSearchTokensQuery } from "./schema";

export type {
  TokenSearchResult,
  SearchPagination,
  SearchFilters,
  TokenSearchResponse,
  TokenSearchErrorResponse,
} from "./types";
