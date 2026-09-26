import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_METADATA_MAX_BYTES,
  validateCampaignMetadata,
  validateImageFile,
  validateMetadata,
} from "../validator";

describe("validateImageFile", () => {
  it("accepts an allowed image type at the size limit", () => {
    expect(validateImageFile({ size: 5 * 1024 * 1024, type: "image/png" } as File)).toEqual({
      valid: true,
    });
  });

  it("rejects oversized images and unsupported types", () => {
    expect(validateImageFile({ size: 5 * 1024 * 1024 + 1, type: "image/png" } as File)).toEqual({
      valid: false,
      error: "File size exceeds 5MB limit",
    });
    expect(validateImageFile({ size: 10, type: "image/svg+xml" } as File)).toEqual({
      valid: false,
      error: "Invalid file type. Allowed: JPEG, PNG, GIF, WebP",
    });
  });
});

describe("validateMetadata", () => {
  it("accepts metadata with the required fields", () => {
    expect(validateMetadata({ name: "Nova", symbol: "NOVA", decimals: 7 })).toEqual({
      valid: true,
    });
  });

  it("rejects missing names and nonnumeric decimals", () => {
    expect(validateMetadata({ symbol: "NOVA", decimals: 7 })).toEqual({
      valid: false,
      error: "Name is required",
    });
    expect(validateMetadata({ name: "Nova", symbol: "NOVA", decimals: "7" })).toEqual({
      valid: false,
      error: "Decimals is required and must be a number",
    });
  });
});

describe("validateCampaignMetadata", () => {
  it("accepts optional metadata and a JSON object", () => {
    expect(validateCampaignMetadata(null)).toEqual({ valid: true });
    expect(validateCampaignMetadata(undefined)).toEqual({ valid: true });
    expect(validateCampaignMetadata('{"strategy":"laddered-buyback"}')).toEqual({ valid: true });
  });

  it("rejects non-string metadata, malformed JSON, and non-object roots", () => {
    expect(validateCampaignMetadata({ strategy: "laddered-buyback" })).toEqual({
      valid: false,
      error: "Metadata must be a string or null",
    });
    expect(validateCampaignMetadata("not json")).toEqual({
      valid: false,
      error: "Metadata must be valid JSON",
    });
    expect(validateCampaignMetadata("[1,2,3]")).toEqual({
      valid: false,
      error: "Metadata must be a JSON object at the root level",
    });
  });

  it("enforces the UTF-8 byte limit", () => {
    const oversizedMetadata = `{"value":"${"é".repeat(CAMPAIGN_METADATA_MAX_BYTES)}"}`;

    expect(validateCampaignMetadata(oversizedMetadata)).toEqual({
      valid: false,
      error: `Metadata exceeds maximum size of ${CAMPAIGN_METADATA_MAX_BYTES} bytes`,
    });
  });
});