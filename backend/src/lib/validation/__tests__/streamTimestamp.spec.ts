import { describe, expect, it } from "vitest";
import {
  MAX_STREAM_TIMESTAMP,
  validateStreamTimestamp,
  validateStreamTimestampOrder,
} from "../streamTimestamp";

describe("validateStreamTimestamp", () => {
  // ── Success paths ──────────────────────────────────────────────────────────

  it("accepts the Unix epoch (0 ms)", () => {
    expect(validateStreamTimestamp(new Date(0))).toEqual({ valid: true });
  });

  it("accepts a normal recent date", () => {
    expect(validateStreamTimestamp(new Date("2024-06-15T12:00:00.000Z"))).toEqual({ valid: true });
  });

  it("accepts the maximum allowed timestamp (year 9999)", () => {
    expect(validateStreamTimestamp(new Date(MAX_STREAM_TIMESTAMP))).toEqual({ valid: true });
  });

  // ── Not a Date instance ────────────────────────────────────────────────────

  it.each([
    ["a number (unix ms)", Date.now()],
    ["a string", "2024-01-01T00:00:00.000Z"],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { time: 0 }],
  ])("rejects %s with 'timestamp must be a Date'", (_label, value) => {
    expect(validateStreamTimestamp(value)).toEqual({
      valid: false,
      reason: "timestamp must be a Date",
    });
  });

  // ── Invalid Date ───────────────────────────────────────────────────────────

  it("rejects an Invalid Date", () => {
    expect(validateStreamTimestamp(new Date("not-a-date"))).toEqual({
      valid: false,
      reason: "timestamp is an invalid Date",
    });
  });

  // ── Pre-epoch (negative ms) ────────────────────────────────────────────────

  it("rejects a date before the Unix epoch (-1 ms)", () => {
    expect(validateStreamTimestamp(new Date(-1))).toEqual({
      valid: false,
      reason: "timestamp must not be before Unix epoch (negative ms)",
    });
  });

  it("rejects a clearly pre-epoch date (year 1969)", () => {
    expect(validateStreamTimestamp(new Date("1969-12-31T23:59:59.999Z"))).toEqual({
      valid: false,
      reason: "timestamp must not be before Unix epoch (negative ms)",
    });
  });

  // ── Far-future cap ─────────────────────────────────────────────────────────

  it("rejects a date one millisecond past the year-9999 cap", () => {
    const oneOver = new Date(MAX_STREAM_TIMESTAMP.getTime() + 1);
    expect(validateStreamTimestamp(oneOver)).toEqual({
      valid: false,
      reason: "timestamp exceeds maximum allowed value (year 9999)",
    });
  });
});

describe("validateStreamTimestampOrder", () => {
  // ── Success paths ──────────────────────────────────────────────────────────

  it("accepts equal timestamps (same instant is monotonically valid)", () => {
    const t = new Date("2024-06-15T12:00:00.000Z");
    expect(validateStreamTimestampOrder(t, t)).toEqual({ valid: true });
  });

  it("accepts a later timestamp strictly after the earlier one", () => {
    const earlier = new Date("2024-01-01T00:00:00.000Z");
    const later = new Date("2024-01-02T00:00:00.000Z");
    expect(validateStreamTimestampOrder(earlier, later)).toEqual({ valid: true });
  });

  // ── Ordering violation ─────────────────────────────────────────────────────

  it("rejects a later timestamp that precedes the earlier one", () => {
    const t1 = new Date("2024-06-15T12:00:00.000Z");
    const t2 = new Date("2024-06-14T12:00:00.000Z");
    expect(validateStreamTimestampOrder(t1, t2)).toEqual({
      valid: false,
      reason: "laterTimestamp must be ≥ earlierTimestamp (monotonic ordering required)",
    });
  });

  it("rejects a claimedAt that would precede createdAt by one millisecond", () => {
    const createdAt = new Date("2024-03-10T08:00:00.001Z");
    const claimedAt = new Date("2024-03-10T08:00:00.000Z");
    expect(validateStreamTimestampOrder(createdAt, claimedAt)).toEqual({
      valid: false,
      reason: "laterTimestamp must be ≥ earlierTimestamp (monotonic ordering required)",
    });
  });
});
