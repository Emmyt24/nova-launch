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
}

/**
 * Webhook subscription creation input
 */
export interface CreateWebhookInput {
  url: string;
  tokenAddress?: string | null;
  events: WebhookEventType[];
  createdBy: string;
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
  | MetadataUpdatedEventData;

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
