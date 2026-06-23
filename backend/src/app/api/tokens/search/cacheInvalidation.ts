/**
 * Keeps the search cache fresh as new tokens are deployed.
 *
 * Subscribes to `token.deployed` on the shared event bus and, for each
 * deployment:
 *  - Invalidates only the search-term buckets whose query could now match
 *    the new token (tag-based invalidation — never flushes the whole cache).
 *  - Warms the cache back up for whichever of those invalidated terms are
 *    among the top 100 most-frequently-queried, so the next search for a
 *    popular term doesn't pay the database round-trip.
 */

import { eventBus } from "../../../../services/eventBus";
import { searchTokensSchema } from "./schema";
import { executeTokenSearch } from "./searchTokens";
import {
  cacheSearchResults,
  getTopQueryTerms,
  invalidateTagsForToken,
} from "./cache";

const TOP_QUERY_LIMIT = 100;

interface TokenDeployedPayload {
  name?: string;
  symbol?: string;
}

async function warmUpTerm(term: string): Promise<void> {
  const validated = searchTokensSchema.parse({ q: term || undefined });
  const cacheKey = JSON.stringify(validated);
  const results = await executeTokenSearch(validated);
  await cacheSearchResults(cacheKey, results, term);
}

export function registerSearchCacheInvalidation(): void {
  eventBus.subscribe<TokenDeployedPayload>("token.deployed", async (event) => {
    const { name, symbol } = event.payload ?? {};
    if (!name || !symbol) return;

    const invalidatedTags = invalidateTagsForToken({ name, symbol });
    if (invalidatedTags.length === 0) return;

    const topTerms = new Set(getTopQueryTerms(TOP_QUERY_LIMIT));
    const warmUpTargets = invalidatedTags.filter((tag) => topTerms.has(tag));

    await Promise.all(
      warmUpTargets.map((tag) =>
        warmUpTerm(tag).catch((err) =>
          console.error(`[searchCache] warm-up failed for "${tag}":`, err)
        )
      )
    );
  });
}

registerSearchCacheInvalidation();
