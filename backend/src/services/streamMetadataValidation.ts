/**
 * Validation and sanitization rules for off-chain stream metadata (#2209).
 *
 * Applied by `PUT /api/streams/:streamId/metadata` before anything reaches
 * `streamMetadataService`. The rules:
 *
 *  - Allowed fields: only `recipient`, `title`, `description` and `tags`.
 *    Unknown keys are rejected rather than silently dropped, so a client
 *    typo (e.g. `tag`) surfaces as an error instead of lost data. The one
 *    exception is `creator`, which older clients send. It's ignored, because
 *    the creator always comes from the caller's JWT (#1901).
 *  - Size: the serialized body may not exceed `maxPayloadBytes` (UTF-8), on
 *    top of the per-field limits below.
 *  - Sanitization: strings go through `normalizeFreeText` (control /
 *    zero-width / bidi-override characters stripped, NFC-normalized,
 *    trimmed). `title` and tags are single-line; `description` keeps line
 *    breaks. Length limits count code points *after* sanitization. HTML is
 *    not encoded here; escaping happens at output boundaries, as for every
 *    other free-text field (see middleware/freeTextSanitization.ts).
 *  - Tags must start with a letter or digit and may then contain letters,
 *    digits, spaces, `_`, `-` and `.`. Duplicates (case-insensitive) are
 *    collapsed, keeping the first spelling.
 *
 * Over-limit input is always rejected, never truncated.
 */

import {
  codePointLength,
  normalizeFreeText,
} from "../middleware/freeTextSanitization";

export const STREAM_METADATA_LIMITS = {
  titleMaxLength: 200,
  descriptionMaxLength: 2000,
  maxTags: 20,
  tagMaxLength: 50,
  recipientMaxLength: 128,
  maxPayloadBytes: 16 * 1024,
} as const;

export const ALLOWED_STREAM_METADATA_FIELDS = [
  "recipient",
  "title",
  "description",
  "tags",
] as const;

/** Fields accepted for backwards compatibility but never used. */
const IGNORED_STREAM_METADATA_FIELDS = new Set(["creator"]);

const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u;

export type StreamMetadataErrorCode =
  | "INVALID_BODY"
  | "PAYLOAD_TOO_LARGE"
  | "UNKNOWN_FIELD"
  | "REQUIRED"
  | "INVALID_TYPE"
  | "TOO_LONG"
  | "TOO_MANY"
  | "INVALID_FORMAT";

export interface StreamMetadataValidationError {
  /** Offending field, e.g. `title` or `tags[3]`; `body` for whole-payload errors. */
  field: string;
  code: StreamMetadataErrorCode;
  message: string;
  limit?: number;
  actual?: number;
}

export interface ValidatedStreamMetadata {
  recipient: string;
  title?: string;
  description?: string;
  tags?: string[];
}

export type StreamMetadataValidationResult =
  | { ok: true; value: ValidatedStreamMetadata }
  | { ok: false; errors: StreamMetadataValidationError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeText(
  field: string,
  raw: unknown,
  maxLength: number,
  multiline: boolean,
  errors: StreamMetadataValidationError[]
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    errors.push({
      field,
      code: "INVALID_TYPE",
      message: `${field} must be a string`,
    });
    return undefined;
  }
  const value = normalizeFreeText(raw, multiline);
  const length = codePointLength(value);
  if (length > maxLength) {
    errors.push({
      field,
      code: "TOO_LONG",
      message: `${field} must be at most ${maxLength} characters (got ${length})`,
      limit: maxLength,
      actual: length,
    });
    return undefined;
  }
  return value === "" ? undefined : value;
}

function sanitizeTags(
  raw: unknown,
  errors: StreamMetadataValidationError[]
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push({
      field: "tags",
      code: "INVALID_TYPE",
      message: "tags must be an array of strings",
    });
    return undefined;
  }

  const { maxTags, tagMaxLength } = STREAM_METADATA_LIMITS;
  if (raw.length > maxTags) {
    errors.push({
      field: "tags",
      code: "TOO_MANY",
      message: `tags may contain at most ${maxTags} entries (got ${raw.length})`,
      limit: maxTags,
      actual: raw.length,
    });
    return undefined;
  }

  const tags: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const field = `tags[${i}]`;
    if (typeof entry !== "string") {
      errors.push({ field, code: "INVALID_TYPE", message: `${field} must be a string` });
      return;
    }
    const tag = normalizeFreeText(entry);
    const length = codePointLength(tag);
    if (length > tagMaxLength) {
      errors.push({
        field,
        code: "TOO_LONG",
        message: `${field} must be at most ${tagMaxLength} characters (got ${length})`,
        limit: tagMaxLength,
        actual: length,
      });
      return;
    }
    if (!TAG_PATTERN.test(tag)) {
      errors.push({
        field,
        code: "INVALID_FORMAT",
        message: `${field} must be non-empty, start with a letter or digit, and contain only letters, digits, spaces, "_", "-" or "."`,
      });
      return;
    }
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  });
  return tags;
}

/**
 * Validate and sanitize a stream-metadata request body. Collects every
 * problem rather than stopping at the first, so clients can fix them in one
 * round trip.
 */
export function validateStreamMetadata(
  body: unknown
): StreamMetadataValidationResult {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      errors: [
        {
          field: "body",
          code: "INVALID_BODY",
          message: "Request body must be a JSON object",
        },
      ],
    };
  }

  const { maxPayloadBytes } = STREAM_METADATA_LIMITS;
  const size = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (size > maxPayloadBytes) {
    return {
      ok: false,
      errors: [
        {
          field: "body",
          code: "PAYLOAD_TOO_LARGE",
          message: `Stream metadata must be at most ${maxPayloadBytes} bytes (got ${size})`,
          limit: maxPayloadBytes,
          actual: size,
        },
      ],
    };
  }

  const errors: StreamMetadataValidationError[] = [];
  const allowed = new Set<string>(ALLOWED_STREAM_METADATA_FIELDS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key) && !IGNORED_STREAM_METADATA_FIELDS.has(key)) {
      errors.push({
        field: key,
        code: "UNKNOWN_FIELD",
        message: `Unknown field "${key}". Allowed fields: ${ALLOWED_STREAM_METADATA_FIELDS.join(", ")}`,
      });
    }
  }

  const recipient = sanitizeText(
    "recipient",
    body.recipient,
    STREAM_METADATA_LIMITS.recipientMaxLength,
    false,
    errors
  );
  if (recipient === undefined && !errors.some((e) => e.field === "recipient")) {
    errors.push({
      field: "recipient",
      code: "REQUIRED",
      message: "recipient is required",
    });
  } else if (recipient !== undefined && /\s/.test(recipient)) {
    errors.push({
      field: "recipient",
      code: "INVALID_FORMAT",
      message: "recipient must not contain whitespace",
    });
  }

  const title = sanitizeText(
    "title",
    body.title,
    STREAM_METADATA_LIMITS.titleMaxLength,
    false,
    errors
  );
  const description = sanitizeText(
    "description",
    body.description,
    STREAM_METADATA_LIMITS.descriptionMaxLength,
    true,
    errors
  );
  const tags = sanitizeTags(body.tags, errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { recipient: recipient!, title, description, tags },
  };
}
