/**
 * Free-Text Field Sanitization Middleware
 *
 * User-supplied free text (token descriptions, proposal titles, stream notes,
 * …) is stored and later rendered by the frontend, emails, and third-party
 * consumers. This module canonicalises that text on the way in and provides
 * an escaping helper for the way out:
 *
 *  1. Strip control characters — C0/C1 controls, DEL, lone UTF-16 surrogates,
 *     zero-width characters, and Unicode bidi overrides (the "Trojan Source"
 *     class of spoofing). Tab/newline are kept only for multiline fields.
 *  2. Normalize Unicode to NFC so visually identical strings compare and
 *     index identically, and so length limits count what the user sees.
 *  3. Enforce per-field length limits, counted in code points *after*
 *     normalization. Over-long input is rejected with 400 — never silently
 *     truncated — so clients learn about the limit.
 *  4. `escapeHtml()` for output into HTML contexts (see notificationService's
 *     email templates). Input is NOT HTML-encoded here: storing raw text and
 *     escaping at the output boundary avoids double-encoding in JSON APIs.
 *
 * Unlike `sanitization.ts` (#846), which HTML-encodes every string in the
 * request, this middleware targets only the configured free-text keys.
 *
 * Issue: #2210
 */

import { Request, Response, NextFunction } from "express";
import { errorResponse } from "../utils/response";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FreeTextFieldRule {
  /** Maximum length in Unicode code points after normalization. */
  maxLength: number;
  /** Keep `\n` and `\t` (other whitespace controls are still stripped). Default: false */
  multiline?: boolean;
}

export type FreeTextFieldRules = Record<string, FreeTextFieldRule>;

export interface FreeTextViolation {
  field: string;
  maxLength: number;
  actualLength: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Body keys treated as free text wherever they appear in a request body
 * (matched at any nesting depth). Keys not listed here are left untouched.
 */
export const DEFAULT_FREE_TEXT_RULES: FreeTextFieldRules = {
  description: { maxLength: 2000, multiline: true },
  summary: { maxLength: 1000, multiline: true },
  notes: { maxLength: 2000, multiline: true },
  bio: { maxLength: 1000, multiline: true },
  reason: { maxLength: 1000, multiline: true },
  title: { maxLength: 200 },
  name: { maxLength: 100 },
};

// ---------------------------------------------------------------------------
// Core sanitization logic
// ---------------------------------------------------------------------------

/**
 * Invisible / control code points that are always removed:
 *  - U+0000–U+0008, U+000B, U+000C, U+000E–U+001F  C0 controls (minus \t \n \r)
 *  - U+007F–U+009F                                DEL + C1 controls
 *  - U+200B–U+200F                                zero-width space/joiners, LRM/RLM
 *  - U+202A–U+202E                                bidi embeddings/overrides
 *  - U+2060–U+2064, U+2066–U+2069                 word joiner, invisible ops, bidi isolates
 *  - U+FEFF                                       BOM / zero-width no-break space
 *  - U+FFF9–U+FFFB                                interlinear annotation controls
 */
const ALWAYS_STRIPPED_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g;

/** Unpaired UTF-16 surrogates — invalid Unicode that breaks downstream encoders. */
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Unicode line/paragraph separators, normalised to `\n`. */
const UNICODE_LINE_BREAK_RE = /[\u2028\u2029]/g;

/**
 * Strip control and invisible characters. For multiline text `\r\n`/`\r` and
 * U+2028/U+2029 become `\n` and tabs are kept; for single-line text every
 * line break and tab collapses to a single space.
 */
export function stripControlChars(value: string, multiline = false): string {
  let out = value
    .replace(LONE_SURROGATE_RE, "")
    .replace(ALWAYS_STRIPPED_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(UNICODE_LINE_BREAK_RE, "\n");

  if (!multiline) {
    out = out.replace(/[\t\n]+/g, " ");
  }
  return out;
}

/** Length in code points, so an emoji counts as one character, not two. */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/**
 * Canonicalise a single free-text value: strip controls, NFC-normalize, and
 * trim. Stripping runs again after normalization because NFC can never
 * introduce controls, but this keeps the function idempotent by construction.
 */
export function normalizeFreeText(value: string, multiline = false): string {
  const stripped = stripControlChars(value, multiline).normalize("NFC");
  return stripControlChars(stripped, multiline).trim();
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "`": "&#x60;",
};

/**
 * Escape text for safe interpolation into HTML element content or quoted
 * attribute values. Use at output boundaries that build HTML (emails, any
 * server-rendered page) — never on data returned as JSON.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Walk `value`, normalizing every string under a key listed in `rules`, and
 * collect length violations. Returns a new structure; the input is not mutated.
 */
export function sanitizeFreeTextFields(
  value: unknown,
  rules: FreeTextFieldRules = DEFAULT_FREE_TEXT_RULES,
  violations: FreeTextViolation[] = [],
  path = ""
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      sanitizeFreeTextFields(item, rules, violations, `${path}[${i}]`)
    );
  }
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    const rule = Object.prototype.hasOwnProperty.call(rules, key)
      ? rules[key]
      : undefined;

    let sanitized: unknown;
    if (rule && typeof child === "string") {
      sanitized = normalizeFreeText(child, rule.multiline ?? false);
      const length = codePointLength(sanitized as string);
      if (length > rule.maxLength) {
        violations.push({
          field: childPath,
          maxLength: rule.maxLength,
          actualLength: length,
        });
      }
    } else {
      sanitized = sanitizeFreeTextFields(child, rules, violations, childPath);
    }

    // defineProperty (not assignment) so a JSON "__proto__" key stays an own
    // data property instead of replacing the result's prototype.
    Object.defineProperty(result, key, {
      value: sanitized,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Create middleware that canonicalises free-text fields in `req.body` and
 * rejects the request with 400 `VALIDATION_ERROR` when any field exceeds its
 * length limit.
 *
 * Usage:
 * ```ts
 * app.use(express.json());
 * app.use(createFreeTextSanitizationMiddleware());
 * ```
 */
export function createFreeTextSanitizationMiddleware(
  rules: FreeTextFieldRules = DEFAULT_FREE_TEXT_RULES
) {
  return function freeTextSanitizationMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (!req.body || typeof req.body !== "object") {
      next();
      return;
    }

    const violations: FreeTextViolation[] = [];
    const sanitized = sanitizeFreeTextFields(req.body, rules, violations);

    if (violations.length > 0) {
      res.status(400).json(
        errorResponse(
          {
            code: "VALIDATION_ERROR",
            message: "One or more text fields exceed their maximum length",
            details: violations,
          },
          req.correlationId
        )
      );
      return;
    }

    req.body = sanitized;
    next();
  };
}

export default createFreeTextSanitizationMiddleware;
