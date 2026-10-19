/**
 * Relevance ranking for token search (#2203).
 *
 * Scoring is tiered so that match quality always dominates popularity:
 *
 *   exact symbol > exact name > symbol prefix > name prefix
 *     > symbol substring > name word / substring > address substring
 *     > typo-tolerant name match
 *
 * Within a tier, tokens are boosted by activity (burn/transfer count) and
 * holder count on a log scale. The boost is capped below the gap between
 * tiers, so a popular partial match can never outrank an exact match.
 * Remaining ties are broken by newest first, then by symbol.
 */

export enum MatchTier {
  None = 0,
  Typo = 100,
  Address = 200,
  NameContains = 300,
  SymbolContains = 400,
  NamePrefix = 500,
  SymbolPrefix = 600,
  ExactName = 700,
  ExactSymbol = 800,
}

/** Max boost from popularity signals — must stay below the tier gap (100). */
export const MAX_POPULARITY_BOOST = 90;
const ACTIVITY_WEIGHT = 9;
const HOLDER_WEIGHT = 9;

export interface RankableToken {
  name: string;
  symbol: string;
  address: string;
  /** Activity signal, e.g. burn count or recent transaction count. */
  activity?: number | null;
  /** Number of holders, when known. */
  holders?: number | null;
  createdAt?: Date | string;
}

export interface RankedToken<T extends RankableToken> {
  token: T;
  score: number;
  tier: MatchTier;
  /** Edit distance for typo matches, otherwise 0. */
  distance: number;
}

const normalize = (s: string) => s.trim().toLowerCase();

/**
 * Damerau–Levenshtein (optimal string alignment) distance, bounded by
 * `max` — returns `max + 1` as soon as the distance is known to exceed it.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1);
      }
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Typos allowed for a query of this length: none for very short terms. */
export function allowedTypos(queryLength: number): number {
  if (queryLength < 4) return 0;
  if (queryLength < 8) return 1;
  return 2;
}

function popularityBoost(token: RankableToken): number {
  const activity = Math.max(0, token.activity ?? 0);
  const holders = Math.max(0, token.holders ?? 0);
  const boost =
    Math.log10(1 + activity) * ACTIVITY_WEIGHT +
    Math.log10(1 + holders) * HOLDER_WEIGHT;
  return Math.min(boost, MAX_POPULARITY_BOOST);
}

/** Smallest edit distance between the query and the name or any of its words. */
function typoDistance(query: string, name: string, max: number): number {
  const candidates = [name, ...name.split(/[\s\-_.]+/).filter(Boolean)];
  let best = max + 1;
  for (const c of candidates) {
    // Compare against an equally long prefix too, so "etherum" matches
    // "ethereum classic" and "bitcon" matches "bitcoin".
    const prefix = c.slice(0, query.length);
    best = Math.min(best, editDistance(query, c, max), editDistance(query, prefix, max));
    if (best === 0) break;
  }
  return best;
}

export function matchTier(
  rawQuery: string,
  token: RankableToken
): { tier: MatchTier; distance: number } {
  const q = normalize(rawQuery);
  if (!q) return { tier: MatchTier.None, distance: 0 };

  const symbol = normalize(token.symbol);
  const name = normalize(token.name);
  const address = normalize(token.address);

  if (symbol === q) return { tier: MatchTier.ExactSymbol, distance: 0 };
  if (name === q) return { tier: MatchTier.ExactName, distance: 0 };
  if (symbol.startsWith(q)) return { tier: MatchTier.SymbolPrefix, distance: 0 };
  if (name.startsWith(q)) return { tier: MatchTier.NamePrefix, distance: 0 };
  if (symbol.includes(q)) return { tier: MatchTier.SymbolContains, distance: 0 };
  if (name.includes(q)) return { tier: MatchTier.NameContains, distance: 0 };
  if (address.includes(q)) return { tier: MatchTier.Address, distance: 0 };

  const max = allowedTypos(q.length);
  if (max > 0) {
    const distance = typoDistance(q, name, max);
    if (distance <= max) return { tier: MatchTier.Typo, distance };
  }
  return { tier: MatchTier.None, distance: 0 };
}

export function scoreToken<T extends RankableToken>(
  query: string,
  token: T
): RankedToken<T> {
  const { tier, distance } = matchTier(query, token);
  if (tier === MatchTier.None) return { token, score: 0, tier, distance };
  // Closer typo matches score higher, still within the Typo tier.
  const typoPenalty = tier === MatchTier.Typo ? distance * 5 : 0;
  const score = tier - typoPenalty + popularityBoost(token);
  return { token, score, tier, distance };
}

const timeOf = (d?: Date | string) => (d ? new Date(d).getTime() || 0 : 0);

/** Score, filter out non-matches and sort tokens by relevance. */
export function rankTokens<T extends RankableToken>(
  query: string,
  tokens: T[],
  limit?: number
): RankedToken<T>[] {
  const ranked = tokens
    .map((t) => scoreToken(query, t))
    .filter((r) => r.tier !== MatchTier.None)
    .sort(
      (a, b) =>
        b.score - a.score ||
        timeOf(b.token.createdAt) - timeOf(a.token.createdAt) ||
        a.token.symbol.localeCompare(b.token.symbol)
    );
  return limit === undefined ? ranked : ranked.slice(0, limit);
}

/** Reads a holder count stored in a token's admin metadata JSON, if any. */
export function holdersFromMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const raw = m.holderCount ?? m.holders;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
