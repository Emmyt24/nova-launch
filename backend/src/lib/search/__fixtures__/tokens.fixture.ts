import type { RankableToken } from "../tokenRanking";

export interface FixtureToken extends RankableToken {
  id: string;
}

/** Fixture dataset for token search ranking tests (#2203). */
export const TOKEN_FIXTURES: FixtureToken[] = [
  { id: "nova", name: "Nova", symbol: "NOVA", address: "CNOVA111", activity: 10, holders: 50, createdAt: "2024-01-01" },
  { id: "nova-classic", name: "Nova Classic", symbol: "NOVC", address: "CNOVC222", activity: 5000, holders: 20000, createdAt: "2024-06-01" },
  { id: "supernova", name: "Supernova", symbol: "SNOVA", address: "CSNOV333", activity: 9000, holders: 90000, createdAt: "2024-07-01" },
  { id: "novaswap", name: "NovaSwap", symbol: "NSWP", address: "CNSWP444", activity: 300, holders: 1200, createdAt: "2024-03-01" },
  { id: "ethereum", name: "Ethereum Wrapped", symbol: "WETH", address: "CWETH555", activity: 100000, holders: 500000, createdAt: "2023-01-01" },
  { id: "bitcoin", name: "Bitcoin Bridge", symbol: "XBTC", address: "CXBTC666", activity: 80000, holders: 300000, createdAt: "2023-02-01" },
  { id: "stellar", name: "Stellar Lumens Plus", symbol: "XLMP", address: "CXLMP777", activity: 50, holders: 100, createdAt: "2024-02-01" },
  { id: "moon-a", name: "Moon Rocket", symbol: "MOON", address: "CMOON888", activity: 1, holders: 2, createdAt: "2024-05-01" },
  { id: "moon-b", name: "Moonbeam Token", symbol: "MBEAM", address: "CMBEM999", activity: 20000, holders: 40000, createdAt: "2024-05-02" },
  { id: "unrelated", name: "Garden Coin", symbol: "GRDN", address: "CGRDN000", activity: 999999, holders: 999999, createdAt: "2024-08-01" },
];
