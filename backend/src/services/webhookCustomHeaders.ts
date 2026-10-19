import {
  CustomHeaderInput,
  StoredCustomHeader,
  PublicCustomHeader,
} from "../types/webhook";
import { decryptHeaderValue, encryptHeaderValue } from "../utils/headerEncryption";

export const MAX_CUSTOM_HEADERS = 20;
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_LENGTH = 2048;

/** RFC 7230 token characters. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Hop-by-hop headers (RFC 7230 §6.1) — meaningless end-to-end. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers set by the delivery pipeline or the HTTP client itself. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "content-encoding",
  "user-agent",
  "expect",
  "x-correlation-id",
  "x-tx-hash",
]);

const RESERVED_PREFIXES = ["x-webhook-", "x-nova-"];

/** Header names whose values are always treated as sensitive. */
const SENSITIVE_NAME_PATTERN = /(^authorization$|^cookie$|api[-_]?key|token|secret|password|auth|signature)/i;

export const MASKED_VALUE = "********";

export class CustomHeaderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomHeaderValidationError";
  }
}

export function isBlockedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    HOP_BY_HOP_HEADERS.has(lower) ||
    RESERVED_HEADERS.has(lower) ||
    RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name);
}

/**
 * Validate custom header input and return the at-rest form, with sensitive
 * values encrypted. Throws CustomHeaderValidationError on invalid input.
 */
export function prepareCustomHeaders(input: unknown): StoredCustomHeader[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new CustomHeaderValidationError("customHeaders must be an array");
  }
  if (input.length > MAX_CUSTOM_HEADERS) {
    throw new CustomHeaderValidationError(
      `At most ${MAX_CUSTOM_HEADERS} custom headers are allowed`
    );
  }

  const seen = new Set<string>();
  return input.map((raw: CustomHeaderInput) => {
    if (!raw || typeof raw !== "object") {
      throw new CustomHeaderValidationError("Each custom header must be an object");
    }
    const { name, value, sensitive } = raw;

    if (typeof name !== "string" || !HEADER_NAME_PATTERN.test(name)) {
      throw new CustomHeaderValidationError(`Invalid header name: "${String(name)}"`);
    }
    if (name.length > MAX_HEADER_NAME_LENGTH) {
      throw new CustomHeaderValidationError(`Header name too long: "${name}"`);
    }
    if (isBlockedHeaderName(name)) {
      throw new CustomHeaderValidationError(
        `Header "${name}" is reserved or hop-by-hop and cannot be set`
      );
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new CustomHeaderValidationError(`Duplicate header: "${name}"`);
    }
    seen.add(lower);

    if (typeof value !== "string") {
      throw new CustomHeaderValidationError(`Header "${name}" value must be a string`);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      throw new CustomHeaderValidationError(`Header "${name}" value too long`);
    }
    // Reject CR/LF/NUL and other control characters (header injection).
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw new CustomHeaderValidationError(
        `Header "${name}" value contains invalid characters`
      );
    }

    const isSensitive = sensitive === true || isSensitiveHeaderName(name);
    return isSensitive
      ? { name, value: encryptHeaderValue(value), sensitive: true }
      : { name, value, sensitive: false };
  });
}

/** Decrypt stored headers into the map sent with each delivery. */
export function resolveCustomHeaders(
  stored: StoredCustomHeader[] | null | undefined
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of stored ?? []) {
    // Defense in depth: never let stored data override protected headers.
    if (isBlockedHeaderName(header.name)) continue;
    headers[header.name] = header.sensitive
      ? decryptHeaderValue(header.value)
      : header.value;
  }
  return headers;
}

/** API-safe view: sensitive values are never returned. */
export function maskCustomHeaders(
  stored: StoredCustomHeader[] | null | undefined
): PublicCustomHeader[] {
  return (stored ?? []).map((header) => ({
    name: header.name,
    value: header.sensitive ? MASKED_VALUE : header.value,
    sensitive: header.sensitive,
  }));
}
