import { NextRequest, NextResponse } from "next/server";
import { searchTokensSchema, type SearchTokensQuery } from "./schema";
import {
  cacheSearchResults,
  getCachedSearchResults,
  recordQueryFrequency,
} from "./cache";
import { executeTokenSearch } from "./searchTokens";
import type { TokenSearchErrorResponse } from "./types";
import "./cacheInvalidation";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    // Parse and validate query parameters
    const queryParams: SearchTokensQuery = {
      q: searchParams.get("q") || undefined,
      creator: searchParams.get("creator") || undefined,
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      minSupply: searchParams.get("minSupply") || undefined,
      maxSupply: searchParams.get("maxSupply") || undefined,
      hasBurns: searchParams.get("hasBurns") || undefined,
      sortBy: (searchParams.get("sortBy") as any) || "created",
      sortOrder: (searchParams.get("sortOrder") as any) || "desc",
      page: searchParams.get("page") || "1",
      limit: searchParams.get("limit") || "20",
    };

    // Validate with Zod
    const validation = searchTokensSchema.safeParse(queryParams);
    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid query parameters",
          details: validation.error.errors,
        },
        { status: 400 }
      );
    }

    const validatedParams = validation.data;

    // Check cache
    const cacheKey = JSON.stringify(validatedParams);
    const cached = await getCachedSearchResults(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    recordQueryFrequency(validatedParams.q);

    const response = await executeTokenSearch(validatedParams);

    // Cache the results, tagged by search term so a new token deployment
    // only needs to invalidate the buckets it could actually affect.
    await cacheSearchResults(cacheKey, response, validatedParams.q);

    return NextResponse.json(response);
  } catch (error) {
    console.error("Token search error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
