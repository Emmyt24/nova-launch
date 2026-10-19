/**
 * Tests for Free-Text Field Sanitization Middleware (#2210)
 *
 * Exercises the sanitizer with hostile payloads: control-character smuggling,
 * bidi "Trojan Source" overrides, zero-width spoofing, lone surrogates,
 * Unicode normalization tricks, length-limit bypasses, and HTML injection at
 * the output boundary.
 */

import { describe, it, expect, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  stripControlChars,
  normalizeFreeText,
  codePointLength,
  escapeHtml,
  sanitizeFreeTextFields,
  createFreeTextSanitizationMiddleware,
  DEFAULT_FREE_TEXT_RULES,
  FreeTextViolation,
} from "./freeTextSanitization";

// ---------------------------------------------------------------------------
// stripControlChars
// ---------------------------------------------------------------------------

describe("stripControlChars", () => {
  it("removes NUL bytes", () => {
    expect(stripControlChars("tok\u0000en")).toBe("token");
  });

  it("removes C0 controls such as BEL, backspace and ESC", () => {
    expect(stripControlChars("a\u0007b\u0008c\u001Bd")).toBe("abcd");
  });

  it("removes ANSI escape introducers used for terminal/log injection", () => {
    // ESC is stripped; the printable remainder is harmless text.
    expect(stripControlChars("\u001B[31mred")).toBe("[31mred");
  });

  it("removes DEL and C1 controls", () => {
    expect(stripControlChars("a\u007Fb\u0085c\u009Bd")).toBe("abcd");
  });

  it("removes bidi override characters (Trojan Source)", () => {
    const payload = "safe\u202Etxt.exe\u202C";
    expect(stripControlChars(payload)).toBe("safetxt.exe");
  });

  it("removes bidi isolates", () => {
    expect(stripControlChars("\u2066a\u2067b\u2068c\u2069")).toBe("abc");
  });

  it("removes zero-width characters used for homograph spoofing", () => {
    expect(stripControlChars("US\u200BDC\u200C\u200D\u2060\uFEFF")).toBe(
      "USDC"
    );
  });

  it("removes lone high and low surrogates but keeps valid pairs", () => {
    expect(stripControlChars("a\uD800b\uDC00c")).toBe("abc");
    expect(stripControlChars("rocket 🚀")).toBe("rocket 🚀");
  });

  it("collapses newlines and tabs to spaces for single-line fields", () => {
    expect(stripControlChars("line1\nline2\tx")).toBe("line1 line2 x");
  });

  it("blocks header-style CRLF injection in single-line fields", () => {
    expect(stripControlChars("Name\r\nBcc: victim@example.com")).toBe(
      "Name Bcc: victim@example.com"
    );
  });

  it("keeps newlines and tabs for multiline fields and normalizes CRLF", () => {
    expect(stripControlChars("a\r\nb\rc\td", true)).toBe("a\nb\nc\td");
  });

  it("normalizes Unicode line/paragraph separators", () => {
    expect(stripControlChars("a\u2028b\u2029c", true)).toBe("a\nb\nc");
    expect(stripControlChars("a\u2028b")).toBe("a b");
  });

  it("leaves ordinary text and non-Latin scripts untouched", () => {
    const text = "Nova Launch — 新星 · Звезда · نجم";
    expect(stripControlChars(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// normalizeFreeText
// ---------------------------------------------------------------------------

describe("normalizeFreeText", () => {
  it("normalizes decomposed characters to NFC", () => {
    const decomposed = "Cafe\u0301"; // e + combining acute
    const result = normalizeFreeText(decomposed);
    expect(result).toBe("Café");
    expect(result).toBe(result.normalize("NFC"));
  });

  it("makes visually identical inputs compare equal", () => {
    expect(normalizeFreeText("n\u0303")).toBe(normalizeFreeText("ñ"));
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeFreeText("  hello  ")).toBe("hello");
  });

  it("trims whitespace exposed after stripping invisible characters", () => {
    expect(normalizeFreeText("\uFEFF  hi \u200B ")).toBe("hi");
  });

  it("is idempotent", () => {
    const hostile = " \u202Ea\u0000b\r\nc\u0301\uD800 ";
    const once = normalizeFreeText(hostile, true);
    expect(normalizeFreeText(once, true)).toBe(once);
  });

  it("does not HTML-encode input (escaping happens on output)", () => {
    expect(normalizeFreeText("<b>bold</b> & co")).toBe("<b>bold</b> & co");
  });
});

// ---------------------------------------------------------------------------
// codePointLength
// ---------------------------------------------------------------------------

describe("codePointLength", () => {
  it("counts astral characters as one code point", () => {
    expect("🚀".length).toBe(2);
    expect(codePointLength("🚀")).toBe(1);
  });

  it("counts plain ASCII by character", () => {
    expect(codePointLength("hello")).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("neutralises a script tag", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  it("neutralises attribute break-out payloads", () => {
    const out = escapeHtml(`" onmouseover="alert(1)`);
    expect(out).not.toContain('"');
    expect(out).toBe("&quot; onmouseover=&quot;alert(1)");
  });

  it("escapes single quotes and backticks", () => {
    expect(escapeHtml("it's `x`")).toBe("it&#x27;s &#x60;x&#x60;");
  });

  it("escapes ampersands first so entities are not double-decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("returns empty string for null and undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("stringifies non-string values", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// sanitizeFreeTextFields
// ---------------------------------------------------------------------------

describe("sanitizeFreeTextFields", () => {
  it("only touches configured keys", () => {
    const input = {
      description: "a\u0000b",
      tokenAddress: "C\u0000ABC",
    };
    const out = sanitizeFreeTextFields(input) as Record<string, string>;
    expect(out.description).toBe("ab");
    expect(out.tokenAddress).toBe("C\u0000ABC");
  });

  it("sanitizes nested objects and arrays", () => {
    const input = {
      metadata: { description: "x\u202Ey" },
      proposals: [{ title: "t1\n" }, { title: "\u200Bt2" }],
    };
    const out = sanitizeFreeTextFields(input) as any;
    expect(out.metadata.description).toBe("xy");
    expect(out.proposals[0].title).toBe("t1");
    expect(out.proposals[1].title).toBe("t2");
  });

  it("does not mutate the input", () => {
    const input = { description: "a\u0000" };
    sanitizeFreeTextFields(input);
    expect(input.description).toBe("a\u0000");
  });

  it("ignores non-string values under free-text keys", () => {
    const input = {
      name: 123,
      description: null,
      title: { nested: "x\u0000" },
    };
    const out = sanitizeFreeTextFields(input, {
      ...DEFAULT_FREE_TEXT_RULES,
      nested: { maxLength: 10 },
    }) as any;
    expect(out.name).toBe(123);
    expect(out.description).toBeNull();
    expect(out.title.nested).toBe("x");
  });

  it("reports length violations with the full field path", () => {
    const violations: FreeTextViolation[] = [];
    sanitizeFreeTextFields(
      { items: [{ title: "x".repeat(201) }] },
      DEFAULT_FREE_TEXT_RULES,
      violations
    );
    expect(violations).toEqual([
      { field: "items[0].title", maxLength: 200, actualLength: 201 },
    ]);
  });

  it("measures length after stripping, so invisible padding cannot exceed limits", () => {
    const violations: FreeTextViolation[] = [];
    const padded = "a".repeat(200) + "\u200B".repeat(5000);
    sanitizeFreeTextFields(
      { title: padded },
      DEFAULT_FREE_TEXT_RULES,
      violations
    );
    expect(violations).toHaveLength(0);
  });

  it("measures length after NFC, so combining sequences count as composed", () => {
    const violations: FreeTextViolation[] = [];
    const rules = { title: { maxLength: 3 } };
    sanitizeFreeTextFields(
      { title: "e\u0301e\u0301e\u0301" },
      rules,
      violations
    );
    expect(violations).toHaveLength(0);
  });

  it("ignores inherited keys such as constructor in the rules lookup", () => {
    const input = JSON.parse('{"constructor": "y\\u0000"}');
    const out = sanitizeFreeTextFields(input) as Record<string, unknown>;
    expect(out.constructor).toBe("y\u0000");
  });

  it("keeps a JSON __proto__ key as data without changing the prototype", () => {
    const input = JSON.parse('{"__proto__": {"description": "p\\u0000"}}');
    const out = sanitizeFreeTextFields(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({
      description: "p",
    });
  });
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function makeReq(body: unknown): Request {
  return { body, correlationId: "cid-test" } as unknown as Request;
}

function makeRes() {
  const res: Partial<Response> & { statusCode?: number; payload?: any } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  res.json = vi.fn((payload: any) => {
    res.payload = payload;
    return res as Response;
  });
  return res;
}

describe("createFreeTextSanitizationMiddleware", () => {
  const middleware = createFreeTextSanitizationMiddleware();

  it("sanitizes the body and calls next", () => {
    const req = makeReq({
      name: "Nova\u0000 Token\r\n",
      description: "Line 1\r\n\u202ELine 2\u202C",
    });
    const res = makeRes();
    const next: NextFunction = vi.fn();

    middleware(req, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({
      name: "Nova Token",
      description: "Line 1\nLine 2",
    });
  });

  it("rejects over-long descriptions with 400 and does not call next", () => {
    const req = makeReq({ description: "x".repeat(2001) });
    const res = makeRes();
    const next: NextFunction = vi.fn();

    middleware(req, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.payload.success).toBe(false);
    expect(res.payload.error.code).toBe("VALIDATION_ERROR");
    expect(res.payload.error.details).toEqual([
      { field: "description", maxLength: 2000, actualLength: 2001 },
    ]);
    expect(res.payload.correlationId).toBe("cid-test");
  });

  it("accepts a description exactly at the limit", () => {
    const req = makeReq({ description: "x".repeat(2000) });
    const next: NextFunction = vi.fn();
    middleware(req, makeRes() as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("counts emoji as single characters against the limit", () => {
    const req = makeReq({ name: "🚀".repeat(100) });
    const next: NextFunction = vi.fn();
    middleware(req, makeRes() as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("reports every violating field at once", () => {
    const req = makeReq({ name: "n".repeat(101), title: "t".repeat(201) });
    const res = makeRes();
    middleware(req, res as Response, vi.fn());
    expect(res.payload.error.details).toHaveLength(2);
  });

  it("passes through requests without a body", () => {
    const req = makeReq(undefined);
    const next: NextFunction = vi.fn();
    middleware(req, makeRes() as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toBeUndefined();
  });

  it("honours custom rules", () => {
    const custom = createFreeTextSanitizationMiddleware({
      memo: { maxLength: 5 },
    });
    const res = makeRes();
    custom(
      makeReq({ memo: "123456", description: "x".repeat(5000) }),
      res as Response,
      vi.fn()
    );
    expect(res.payload.error.details).toEqual([
      { field: "memo", maxLength: 5, actualLength: 6 },
    ]);
  });

  it("neutralises a combined hostile payload end to end", () => {
    const hostile = {
      name: "\u202Egnp.exe\u202C\u0000<img src=x onerror=alert(1)>",
      description: "\uFEFFHello\u0007\r\n\uD800World\u2028<script>x</script>",
    };
    const req = makeReq(hostile);
    const next: NextFunction = vi.fn();

    middleware(req, makeRes() as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body.name).toBe("gnp.exe<img src=x onerror=alert(1)>");
    expect(req.body.description).toBe("Hello\nWorld\n<script>x</script>");
    // Markup survives storage verbatim but is inert once escaped on output.
    expect(escapeHtml(req.body.name)).not.toMatch(/[<>]/);
    expect(escapeHtml(req.body.description)).not.toMatch(/[<>]/);
  });
});
