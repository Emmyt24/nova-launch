import { describe, expect, it } from "vitest";
import {
  validateGovernancePercentage,
  validateGovernancePercentagePair,
} from "../governancePercentage";

describe("validateGovernancePercentage", () => {
  it("accepts inclusive boundary values", () => {
    expect(validateGovernancePercentage(0)).toEqual({ valid: true });
    expect(validateGovernancePercentage(100)).toEqual({ valid: true });
  });

  it.each([
    ["a string", "value must be a number"],
    [Number.POSITIVE_INFINITY, "value must be finite"],
    [50.5, "value must be an integer"],
    [-1, "value must be >= 0"],
    [101, "value must be <= 100"],
  ])("rejects %s with a useful reason", (value, reason) => {
    expect(validateGovernancePercentage(value)).toEqual({ valid: false, reason });
  });
});

describe("validateGovernancePercentagePair", () => {
  it("accepts a reachable pair and any valid threshold when quorum is zero", () => {
    expect(validateGovernancePercentagePair(50, 25)).toEqual({ valid: true });
    expect(validateGovernancePercentagePair(0, 100)).toEqual({ valid: true });
  });

  it("reports an invalid quorum", () => {
    expect(validateGovernancePercentagePair(101, 25)).toEqual({
      valid: false,
      reason: "quorumPct: value must be <= 100",
    });
  });

  it("reports an invalid threshold", () => {
    expect(validateGovernancePercentagePair(50, "25")).toEqual({
      valid: false,
      reason: "thresholdPct: value must be a number",
    });
  });

  it("rejects an unreachable threshold", () => {
    expect(validateGovernancePercentagePair(25, 50)).toEqual({
      valid: false,
      reason: "thresholdPct must not exceed quorumPct when quorumPct > 0",
    });
  });
});