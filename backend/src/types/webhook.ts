/**
 * Webhook event types
 */
export enum WebhookEventType {
  TOKEN_BURN_SELF = "token.burn.self",
  TOKEN_BURN_ADMIN = "token.burn.admin",
  TOKEN_CREATED = "token.created",
  TOKEN_METADATA_UPDATED = "token.metadata.updated",
}

/**
 * Webhook subscription model
 */
export interface WebhookSubscription {
  id: string;
  url: string;
  tokenAddress: string | null;
  events: WebhookEventType[];
  secret: string;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  lastTriggered: Date | null;
  /** Set when the subscription has been soft-deleted; null otherwise. */
  deletedAt?: Date | null;
  /** Custom headers sent with every delivery (sensitive values encrypted). */
  customHeaders?: StoredCustomHeader[];
}

/**
 * Custom header as supplied by the API caller.
 */
export interface CustomHeaderInput {
  name: string;
  value: string;
  /** Force encryption/masking even if the name is not recognised as sensitive. */
  sensitive?: boolean;
}

/**
 * Custom header as stored. When `sensitive` is true, `value` is an
 * AES-256-GCM ciphertext (see utils/headerEncryption).
 */
export interface StoredCustomHeader {
  name: string;
  value: string;
  sensitive: boolean;
}

/**
 * Custom header as returned by the API; sensitive values are masked.
 */
export interface PublicCustomHeader {
  name: string;
  value: string;
  sensitive: boolean;
}

/**
 * Webhook subscription creation input
 */
export interface CreateWebhookInput {
  url: string;
  tokenAddress?: string | null;
  events: WebhookEventType[];
  createdBy: string;
  customHeaders?: CustomHeaderInput[];
}

/**
 * Webhook payload structure
 */
export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: WebhookEventData;
  signature: string;
}

/**
 * Event data for different webhook types
 */
export type WebhookEventData =
  | BurnEventData
  | TokenCreatedEventData
  | MetadataUpdatedEventData
  | TruncatedEventData;

/**
 * Replacement event data sent when the original payload exceeds
 * WEBHOOK_MAX_PAYLOAD_BYTES. Small scalar fields from the original data are
 * kept alongside these markers.
 */
export interface TruncatedEventData {
  truncated: true;
  originalSizeBytes: number;
  maxSizeBytes: number;
  droppedFields: string[];
  fullDataUrl?: string;
  tokenAddress?: string;
  transactionHash?: string;
  ledger?: number;
  [field: string]: unknown;
}

export interface BurnEventData {
  tokenAddress: string;
  from: string;
  amount: string;
  burner: string;
  transactionHash: string;
  ledger: number;
}

export interface TokenCreatedEventData {
  tokenAddress: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
  transactionHash: string;
  ledger: number;
}

export interface MetadataUpdatedEventData {
  tokenAddress: string;
  metadataUri: string;
  updatedBy: string;
  transactionHash: string;
  ledger: number;
}

/**
 * Webhook delivery log
 */
export interface WebhookDeliveryLog {
  id: string;
  subscriptionId: string;
  event: WebhookEventType;
  payload: WebhookPayload;
  statusCode: number | null;
  success: boolean;
  attempts: number;
  lastAttemptAt: Date;
  errorMessage: string | null;
  createdAt: Date;
}

/**
 * Webhook delivery status
 */
export enum WebhookDeliveryStatus {
  PENDING = "pending",
  SUCCESS = "success",
  FAILED = "failed",
  RETRYING = "retrying",
}
