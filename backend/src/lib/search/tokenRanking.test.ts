import { describe, it, expect } from "vitest";
import {
  MatchTier,
  MAX_POPULARITY_BOOST,
  allowedTypos,
  editDistance,
  holdersFromMetadata,
  matchTier,
  rankTokens,
  scoreToken,
} from "./tokenRanking";
import { TOKEN_FIXTURES } from "./__fixtures__/tokens.fixture";

const ids = (q: string, limit?: number) =>
  rankTokens(q, TOKEN_FIXTURES, limit).map((r) => r.token.id);

describe("token search ranking (#2203)", () => {
  describe("exact symbol matches rank above partial matches", () => {
    it("puts the exact symbol first even when partial matches are far more popular", () => {
      const result = ids("nova");
      expect(result[0]).toBe("nova");
      expect(result).toEqual(
        expect.arrayContaining(["nova-classic", "supernova", "novaswap"])
      );
    });

    it("is case-insensitive and trims whitespace", () => {
      expect(ids("  NoVa ")[0]).toBe("nova");
    });

    it("ranks symbol prefix above name substring", () => {
      expect(matchTier("snov", TOKEN_FIXTURES[2]).tier).toBe(MatchTier.SymbolPrefix);
      expect(matchTier("nova", TOKEN_FIXTURES[2]).tier).toBe(MatchTier.SymbolContains);
    });

    it("orders tiers exact > prefix > contains", () => {
      const tiers = rankTokens("nova", TOKEN_FIXTURES).map((r) => r.tier);
      const sorted = [...tiers].sort((a, b) => b - a);
      expect(tiers).toEqual(sorted);
    });

    it("excludes tokens that do not match at all, regardless of popularity", () => {
      expect(ids("nova")).not.toContain("unrelated");
    });
  });

  describe("boost by activity and holders", () => {
    it("never lets popularity lift a weaker match above a stronger one", () => {
      // MOON (exact symbol, almost no activity) vs Moonbeam (name prefix, very popular)
      expect(ids("moon")).toEqual(["moon-a", "moon-b"]);
      const ranked = rankTokens("moo", TOKEN_FIXTURES);
      expect(ranked.map((r) => r.token.id)).toEqual(["moon-a", "moon-b"]);
      expect(ranked[0].tier).toBe(MatchTier.SymbolPrefix);
      expect(ranked[1].tier).toBe(MatchTier.NamePrefix);
    });

    it("ranks popular tokens higher among same-tier matches", () => {
      const ranked = rankTokens("nov", TOKEN_FIXTURES).filter(
        (r) => r.tier === MatchTier.SymbolPrefix
      );
      // NOVA (low activity) vs NOVC (high activity), both symbol prefix
      expect(ranked.map((r) => r.token.id)).toEqual(["nova-classic", "nova"]);
    });

    it("caps the popularity boost below the tier gap", () => {
      const huge = { name: "x", symbol: "abcd", address: "c", activity: 1e12, holders: 1e12 };
      const r = scoreToken("abcd", huge);
      expect(r.score - MatchTier.ExactSymbol).toBeLessThanOrEqual(MAX_POPULARITY_BOOST);
      expect(MAX_POPULARITY_BOOST).toBeLessThan(100);
    });

    it("treats missing or negative signals as zero", () => {
      const r = scoreToken("abcd", { name: "x", symbol: "abcd", address: "c", activity: -5, holders: null });
      expect(r.score).toBe(MatchTier.ExactSymbol);
    });
  });

  describe("typo tolerance for names", () => {
    it("matches a single-letter typo", () => {
      expect(ids("bitcon")).toContain("bitcoin");
      expect(ids("stelar")).toContain("stellar");
    });

    it("matches transpositions", () => {
      expect(ids("etheruem")).toContain("ethereum");
    });

    it("allows two edits for long queries", () => {
      expect(ids("etherium wraped")).toContain("ethereum");
    });

    it("does not apply typo tolerance to very short queries", () => {
      expect(allowedTypos(3)).toBe(0);
      expect(ids("xbt")).toEqual(["bitcoin"]);
      expect(ids("zzz")).toEqual([]);
    });

    it("ranks typo matches below real partial matches", () => {
      const ranked = rankTokens("moonb", TOKEN_FIXTURES);
      expect(ranked[0].token.id).toBe("moon-b");
      expect(ranked[0].tier).toBeGreaterThan(MatchTier.Typo);
    });

    it("scores closer typos higher", () => {
      const one = scoreToken("bitcoim", TOKEN_FIXTURES[5]);
      const two = scoreToken("bitxoim", TOKEN_FIXTURES[5]);
      expect(one.tier).toBe(MatchTier.Typo);
      expect(two.tier).toBe(MatchTier.None); // 7 chars → 1 typo allowed
      expect(one.distance).toBe(1);
    });
  });

  describe("helpers", () => {
    it("computes Damerau-Levenshtein distance", () => {
      expect(editDistance("kitten", "sitting")).toBe(3);
      expect(editDistance("abcd", "abdc")).toBe(1);
      expect(editDistance("same", "same")).toBe(0);
    });

    it("bails out early past the max distance", () => {
      expect(editDistance("aaaaaaaa", "bbbbbbbb", 2)).toBe(3);
    });

    it("reads holder count from metadata", () => {
      expect(holdersFromMetadata({ holderCount: 42 })).toBe(42);
      expect(holdersFromMetadata({ holders: "7" })).toBe(7);
      expect(holdersFromMetadata({})).toBeNull();
      expect(holdersFromMetadata(null)).toBeNull();
    });

    it("respects the limit", () => {
      expect(ids("nova", 2)).toHaveLength(2);
    });
  });
});
