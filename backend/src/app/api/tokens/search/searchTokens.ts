import { prisma } from "../../../../lib/prisma";
import { buildTokenSearchQuery } from "./query-builder";
import type { ValidatedSearchTokensQuery } from "./schema";
import type { TokenSearchResponse } from "./types";

/**
 * Run a validated token search against the database and shape the API
 * response. Extracted from the route handler so the cache warm-up job can
 * re-populate popular search terms without going through an HTTP request.
 */
export async function executeTokenSearch(
  params: ValidatedSearchTokensQuery
): Promise<TokenSearchResponse> {
  const { where, orderBy } = buildTokenSearchQuery(params);

  const page = parseInt(params.page);
  const limit = parseInt(params.limit);
  const skip = (page - 1) * limit;

  const [tokens, total] = await Promise.all([
    prisma.token.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select: {
        id: true,
        address: true,
        creator: true,
        name: true,
        symbol: true,
        decimals: true,
        totalSupply: true,
        initialSupply: true,
        totalBurned: true,
        burnCount: true,
        metadataUri: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.token.count({ where }),
  ]);

  return {
    success: true,
    data: tokens.map((token): any => ({
      ...token,
      totalSupply: token.totalSupply.toString(),
      initialSupply: token.initialSupply.toString(),
      totalBurned: token.totalBurned.toString(),
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page < Math.ceil(total / limit),
      hasPrev: page > 1,
    },
    filters: {
      q: params.q,
      creator: params.creator,
      startDate: params.startDate,
      endDate: params.endDate,
      minSupply: params.minSupply,
      maxSupply: params.maxSupply,
      hasBurns: params.hasBurns,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    },
  };
}
