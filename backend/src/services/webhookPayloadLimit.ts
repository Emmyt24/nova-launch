import { WebhookEventData, WebhookEventType, TruncatedEventData } from "../types/webhook";

/** Default maximum size of a delivered webhook body (256 KiB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

/** String fields longer than this are dropped when a payload is truncated. */
const MAX_RETAINED_STRING_LENGTH = 256;

/** Fields that identify the event and are always kept when possible. */
const IDENTIFYING_FIELDS = ["tokenAddress", "transactionHash", "ledger"] as const;

// Worst-case signature header: "v1.<10-digit ts>.<64 hex chars>".
const SIGNATURE_PLACEHOLDER = `v1.${"0".repeat(10)}.${"0".repeat(64)}`;
const TIMESTAMP_PLACEHOLDER = new Date(0).toISOString();

export interface PayloadLimitOptions {
  maxBytes?: number;
  /**
   * Template for a link receivers can follow to fetch the full data, e.g.
   * `https://api.example.com/tokens/{tokenAddress}`. `{field}` placeholders
   * are filled from the original event data (URL-encoded).
   */
  fullDataUrlTemplate?: string;
}

export interface PayloadLimitResult {
  data: WebhookEventData;
  truncated: boolean;
  originalSizeBytes: number;
  finalSizeBytes: number;
  maxSizeBytes: number;
  droppedFields: string[];
}

export function getMaxPayloadBytes(
  raw: string | undefined = process.env.WEBHOOK_MAX_PAYLOAD_BYTES
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PAYLOAD_BYTES;
}

/**
 * Size in bytes of the JSON body that would be delivered for this data,
 * including the envelope (`event`, `timestamp`, `signature`).
 */
export function measurePayloadBytes(
  event: WebhookEventType,
  data: WebhookEventData
): number {
  return Buffer.byteLength(
    JSON.stringify({
      event,
      timestamp: TIMESTAMP_PLACEHOLDER,
      data,
      signature: SIGNATURE_PLACEHOLDER,
    }),
    "utf8"
  );
}

export function buildFullDataUrl(
  template: string | undefined,
  data: Record<string, unknown>
): string | undefined {
  if (!template) return undefined;
  let missing = false;
  const url = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = data[key];
    if (value === undefined || value === null) {
      missing = true;
      return "";
    }
    return encodeURIComponent(String(value));
  });
  return missing ? undefined : url;
}

function isSmallScalar(value: unknown): boolean {
  if (typeof value === "number" || typeof value === "boolean") return true;
  return typeof value === "string" && value.length <= MAX_RETAINED_STRING_LENGTH;
}

/**
 * Enforce the maximum payload size. Payloads within the limit are returned
 * unchanged. Larger payloads are replaced by a truncated form that keeps
 * small scalar fields, drops the rest, and links to the full data when a
 * URL template is configured.
 */
export function applyPayloadSizeLimit(
  event: WebhookEventType,
  data: WebhookEventData,
  options: PayloadLimitOptions = {}
): PayloadLimitResult {
  const maxSizeBytes = options.maxBytes ?? getMaxPayloadBytes();
  const fullDataUrlTemplate =
    options.fullDataUrlTemplate ?? process.env.WEBHOOK_FULL_DATA_URL_TEMPLATE;
  const originalSizeBytes = measurePayloadBytes(event, data);

  if (originalSizeBytes <= maxSizeBytes) {
    return {
      data,
      truncated: false,
      originalSizeBytes,
      finalSizeBytes: originalSizeBytes,
      maxSizeBytes,
      droppedFields: [],
    };
  }

  const source = data as unknown as Record<string, unknown>;
  const fullDataUrl = buildFullDataUrl(fullDataUrlTemplate, source);

  const retained: Record<string, unknown> = {};
  const droppedFields: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (isSmallScalar(value)) retained[key] = value;
    else droppedFields.push(key);
  }

  const build = (fields: Record<string, unknown>): TruncatedEventData => ({
    ...fields,
    truncated: true,
    originalSizeBytes,
    maxSizeBytes,
    droppedFields: [...droppedFields],
    ...(fullDataUrl && { fullDataUrl }),
  });

  let truncatedData = build(retained);

  // Still too large (many small fields) — fall back to identifying fields only.
  if (measurePayloadBytes(event, truncatedData) > maxSizeBytes) {
    const minimal: Record<string, unknown> = {};
    for (const key of Object.keys(retained)) {
      if ((IDENTIFYING_FIELDS as readonly string[]).includes(key)) {
        minimal[key] = retained[key];
      } else {
        droppedFields.push(key);
      }
    }
    truncatedData = build(minimal);
  }

  return {
    data: truncatedData,
    truncated: true,
    originalSizeBytes,
    finalSizeBytes: measurePayloadBytes(event, truncatedData),
    maxSizeBytes,
    droppedFields: truncatedData.droppedFields,
  };
}
