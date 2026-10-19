/**
 * Tests for stream metadata validation limits (#2209).
 */
import { describe, it, expect } from "vitest";
import {
  ALLOWED_STREAM_METADATA_FIELDS,
  STREAM_METADATA_LIMITS,
  validateStreamMetadata,
} from "./streamMetadataValidation";

function expectErrors(body: unknown) {
  const result = validateStreamMetadata(body);
  if (result.ok) throw new Error("expected validation to fail");
  return result.errors;
}

function expectValue(body: unknown) {
  const result = validateStreamMetadata(body);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe("validateStreamMetadata", () => {
  it("accepts a valid payload", () => {
    expect(
      expectValue({
        recipient: "GRECIPIENT",
        title: "Payroll",
        description: "Monthly\nvesting",
        tags: ["payroll", "q4-2026"],
      })
    ).toEqual({
      recipient: "GRECIPIENT",
      title: "Payroll",
      description: "Monthly\nvesting",
      tags: ["payroll", "q4-2026"],
    });
  });

  it("leaves optional fields undefined when omitted", () => {
    expect(expectValue({ recipient: "GRECIPIENT" })).toEqual({
      recipient: "GRECIPIENT",
      title: undefined,
      description: undefined,
      tags: undefined,
    });
  });

  describe("allowed fields", () => {
    it("exposes the allow-list", () => {
      expect(ALLOWED_STREAM_METADATA_FIELDS).toEqual([
        "recipient",
        "title",
        "description",
        "tags",
      ]);
    });

    it("rejects unknown fields by name", () => {
      const errors = expectErrors({ recipient: "G", tag: ["x"], owner: "GEVIL" });
      expect(errors).toEqual([
        expect.objectContaining({ field: "tag", code: "UNKNOWN_FIELD" }),
        expect.objectContaining({ field: "owner", code: "UNKNOWN_FIELD" }),
      ]);
      expect(errors[0].message).toContain("Allowed fields: recipient, title, description, tags");
    });

    it("ignores a legacy creator field instead of using it", () => {
      const value = expectValue({ recipient: "G", creator: "GEVIL" });
      expect(value).not.toHaveProperty("creator");
    });

    it.each([null, "string", ["array"], 42])("rejects a non-object body (%j)", (body) => {
      expect(expectErrors(body)).toEqual([
        expect.objectContaining({ field: "body", code: "INVALID_BODY" }),
      ]);
    });
  });

  describe("size limits", () => {
    it("rejects payloads over the byte limit", () => {
      const errors = expectErrors({
        recipient: "G",
        description: "x".repeat(STREAM_METADATA_LIMITS.maxPayloadBytes),
      });
      expect(errors).toEqual([
        expect.objectContaining({
          field: "body",
          code: "PAYLOAD_TOO_LARGE",
          limit: STREAM_METADATA_LIMITS.maxPayloadBytes,
        }),
      ]);
    });

    it("rejects a title over the limit with the limit and actual length", () => {
      const errors = expectErrors({ recipient: "G", title: "x".repeat(201) });
      expect(errors).toEqual([
        {
          field: "title",
          code: "TOO_LONG",
          message: "title must be at most 200 characters (got 201)",
          limit: 200,
          actual: 201,
        },
      ]);
    });

    it("rejects a description over the limit", () => {
      const errors = expectErrors({ recipient: "G", description: "x".repeat(2001) });
      expect(errors[0]).toMatchObject({ field: "description", code: "TOO_LONG", limit: 2000 });
    });

    it("counts code points, not UTF-16 units", () => {
      expect(expectValue({ recipient: "G", title: "🚀".repeat(200) }).title).toHaveLength(400);
    });

    it("rejects too many tags", () => {
      const errors = expectErrors({
        recipient: "G",
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
      });
      expect(errors[0]).toMatchObject({ field: "tags", code: "TOO_MANY", limit: 20, actual: 21 });
    });

    it("rejects an over-long tag by index", () => {
      const errors = expectErrors({ recipient: "G", tags: ["ok", "x".repeat(51)] });
      expect(errors[0]).toMatchObject({ field: "tags[1]", code: "TOO_LONG", limit: 50 });
    });
  });

  describe("sanitization", () => {
    it("strips control, zero-width and bidi-override characters", () => {
      const value = expectValue({
        recipient: "GRECIPIENT",
        title: "Pay\u0000roll​ ‮evil",
      });
      expect(value.title).toBe("Payroll evil");
    });

    it("collapses line breaks in single-line fields but keeps them in description", () => {
      const value = expectValue({
        recipient: "G",
        title: "a\nb",
        description: "line1\r\nline2",
      });
      expect(value.title).toBe("a b");
      expect(value.description).toBe("line1\nline2");
    });

    it("trims and NFC-normalizes", () => {
      expect(expectValue({ recipient: "G", title: "  Café  " }).title).toBe("Café");
    });

    it("measures limits after sanitization", () => {
      const padded = "x".repeat(200) + "​".repeat(10);
      expect(expectValue({ recipient: "G", title: padded }).title).toHaveLength(200);
    });

    it("treats whitespace-only optional text as absent", () => {
      expect(expectValue({ recipient: "G", title: "   " }).title).toBeUndefined();
    });

    it("dedupes tags case-insensitively, keeping the first spelling", () => {
      expect(expectValue({ recipient: "G", tags: ["DeFi", "defi", " DEFI "] }).tags).toEqual([
        "DeFi",
      ]);
    });

    it("does not HTML-encode (escaping happens at output)", () => {
      expect(expectValue({ recipient: "G", title: "<b>hi</b>" }).title).toBe("<b>hi</b>");
    });
  });

  describe("field rules", () => {
    it("requires recipient", () => {
      expect(expectErrors({ title: "x" })).toEqual([
        { field: "recipient", code: "REQUIRED", message: "recipient is required" },
      ]);
    });

    it("rejects a recipient containing whitespace", () => {
      expect(expectErrors({ recipient: "G ABC" })[0]).toMatchObject({
        field: "recipient",
        code: "INVALID_FORMAT",
      });
    });

    it("rejects non-string text fields", () => {
      const errors = expectErrors({ recipient: 5, title: { x: 1 } });
      expect(errors.map((e) => [e.field, e.code])).toEqual([
        ["recipient", "INVALID_TYPE"],
        ["title", "INVALID_TYPE"],
      ]);
    });

    it("rejects tags that are not an array", () => {
      expect(expectErrors({ recipient: "G", tags: "defi" })[0]).toMatchObject({
        field: "tags",
        code: "INVALID_TYPE",
      });
    });

    it.each([
      ["empty", ""],
      ["punctuation-led", "-defi"],
      ["markup", "<script>"],
    ])("rejects a %s tag", (_label, tag) => {
      expect(expectErrors({ recipient: "G", tags: [tag] })[0]).toMatchObject({
        field: "tags[0]",
        code: "INVALID_FORMAT",
      });
    });

    it("rejects non-string tag entries", () => {
      expect(expectErrors({ recipient: "G", tags: [1] })[0]).toMatchObject({
        field: "tags[0]",
        code: "INVALID_TYPE",
      });
    });

    it("reports every problem at once", () => {
      const errors = expectErrors({
        title: "x".repeat(201),
        tags: ["ok", "!bad"],
        extra: true,
      });
      expect(errors.map((e) => e.field).sort()).toEqual(
        ["extra", "recipient", "tags[1]", "title"].sort()
      );
    });
  });
});
