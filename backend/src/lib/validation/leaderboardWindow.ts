/**
 * Leaderboard time-window parameter validation (#2204).
 *
 * Supported windows: `24h`, `7d`, `30d` and `all` (all-time). A handful of
 * common aliases are accepted and normalised so clients don't have to know
 * the canonical spelling. Anything else is rejected with a clear error
 * instead of silently falling back to a default window.
 */

import { TimePeriod } from "../../services/leaderboardService";

export const LEADERBOARD_WINDOWS: readonly TimePeriod[] = [
  TimePeriod.H24,
  TimePeriod.D7,
  TimePeriod.D30,
  TimePeriod.ALL,
];

const WINDOW_ALIASES: Record<string, TimePeriod> = {
  "24h": TimePeriod.H24,
  "1d": TimePeriod.H24,
  day: TimePeriod.H24,
  "7d": TimePeriod.D7,
  "1w": TimePeriod.D7,
  week: TimePeriod.D7,
  "30d": TimePeriod.D30,
  "1m": TimePeriod.D30,
  month: TimePeriod.D30,
  all: TimePeriod.ALL,
  "all-time": TimePeriod.ALL,
  alltime: TimePeriod.ALL,
  all_time: TimePeriod.ALL,
};

export type WindowParseResult =
  | { ok: true; window: TimePeriod }
  | { ok: false; error: { code: "INVALID_PARAMETERS"; message: string; details: Record<string, unknown> } };

/**
 * Parse a `period`/`window` query value. `undefined` or empty yields
 * `fallback`. Arrays (repeated query params) are rejected.
 */
export function parseLeaderboardWindow(
  raw: unknown,
  fallback: TimePeriod = TimePeriod.D7
): WindowParseResult {
  if (raw === undefined || raw === "") return { ok: true, window: fallback };

  if (typeof raw !== "string") {
    return invalid(raw, "period must be provided once as a string");
  }

  const normalised = WINDOW_ALIASES[raw.trim().toLowerCase()];
  if (!normalised) {
    return invalid(raw, `Invalid period "${raw}"`);
  }
  return { ok: true, window: normalised };
}

function invalid(received: unknown, message: string): WindowParseResult {
  return {
    ok: false,
    error: {
      code: "INVALID_PARAMETERS",
      message: `${message}. Allowed values: ${LEADERBOARD_WINDOWS.join(", ")}`,
      details: {
        parameter: "period",
        received,
        allowed: [...LEADERBOARD_WINDOWS],
      },
    },
  };
}

