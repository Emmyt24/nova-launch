/**
 * NotificationService
 *
 * Delivers notifications across WEBHOOK, EMAIL, and SMS channels.
 *
 * Provider strategy (EMAIL):
 *   1. If SENDGRID_API_KEY is set → use SendGrid REST API
 *   2. Else if NOTIFICATION_EMAIL_API_URL is set → use generic HTTP adapter (legacy)
 *   3. Else → log warning and return unconfigured error
 *
 * Provider strategy (SMS):
 *   1. If TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are set → use Twilio REST API
 *   2. Else if NOTIFICATION_SMS_API_URL is set → use generic HTTP adapter (legacy)
 *   3. Else → log warning and return unconfigured error
 *
 * Delivery failures are retried with exponential backoff via WebhookRetryService.
 * PII (email address / phone number) is masked in all log output.
 * A per-recipient-per-event-type rate limiter prevents notification spam.
 *
 * Issue: #1264
 */

import axios, { AxiosError } from "axios";
import { readFileSync } from "fs";
import { join } from "path";
import webhookDeliveryService from "./webhookDeliveryService";
import { WebhookRetryService } from "./webhookRetry";
import type { AttemptResult, RetryOutcome } from "./webhookRetry";
import {
  NotificationChannelType,
  NotificationPayload,
  NotificationRequest,
  NotificationResult,
  NotificationTarget,
} from "../types/notification";
import { IntegrationMetrics } from "../lib/metrics";
import { CircuitBreaker, CircuitBreakerOpenError, registerCircuitBreaker } from "../lib/circuitBreaker";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_AGENT = "Nova-Launch-Notification/1.0";

/**
 * Max delivery attempts (including the initial try).
 * Overridable via MAX_RETRIES env var.
 */
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES ?? "3", 10);

/**
 * Rate-limit window in milliseconds (default: 1 hour).
 * One notification per recipient per event type per window.
 */
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.NOTIFICATION_RATE_LIMIT_WINDOW_MS ?? String(60 * 60 * 1000),
  10
);

// ---------------------------------------------------------------------------
// PII helpers
// ---------------------------------------------------------------------------

/**
 * Mask an email address for safe log output.
 * "user@example.com" → "****@example.com"
 */
function maskEmail(email: string): string {
  const atIdx = email.indexOf("@");
  if (atIdx < 0) return "****";
  return `****${email.slice(atIdx)}`;
}

/**
 * Mask a phone number for safe log output.
 * "+15551234567" → "****4567"
 */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return `****${phone.slice(-4)}`;
}

/**
 * Mask a generic destination.
 * Heuristic: if it contains '@' treat as email, otherwise as phone.
 */
function maskDestination(dest: string): string {
  return dest.includes("@") ? maskEmail(dest) : maskPhone(dest);
}

// ---------------------------------------------------------------------------
// Template loader
// ---------------------------------------------------------------------------

/** Supported template keys tied to known notification events. */
export type EmailTemplateKey =
  | "TOKEN_DEPLOYED"
  | "VAULT_MATURED"
  | "PROPOSAL_PASSED";

const TEMPLATE_FILES: Record<EmailTemplateKey, string> = {
  TOKEN_DEPLOYED: "token-deployed.html",
  VAULT_MATURED: "vault-matured.html",
  PROPOSAL_PASSED: "proposal-passed.html",
};

const TEMPLATES_DIR = join(__dirname, "../templates/email");

/** Template cache — loaded once per process lifetime. */
const templateCache = new Map<EmailTemplateKey, string>();

/**
 * Load an HTML email template and interpolate {{variable}} placeholders.
 * Falls back to plain-text `payload.message` if the template cannot be read.
 */
function renderTemplate(
  key: EmailTemplateKey,
  vars: Record<string, string>
): string {
  if (!templateCache.has(key)) {
    try {
      const raw = readFileSync(join(TEMPLATES_DIR, TEMPLATE_FILES[key]), "utf8");
      templateCache.set(key, raw);
    } catch {
      // Template file not found — caller falls back to plain text
      return vars.message ?? "";
    }
  }
  let html = templateCache.get(key)!;
  for (const [k, v] of Object.entries(vars)) {
    html = html.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v ?? "");
  }
  return html;
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  lastSentAt: number;
}

/**
 * In-process rate limiter keyed on `${destination}:${eventType}`.
 * Prevents notification spam: one delivery per recipient per event per window.
 * In production, replace with a Redis-backed store for multi-instance safety.
 */
const rateLimitStore = new Map<string, RateLimitEntry>();

function isRateLimited(destination: string, eventType: string): boolean {
  const key = `${destination}:${eventType}`;
  const entry = rateLimitStore.get(key);
  if (!entry) return false;
  return Date.now() - entry.lastSentAt < RATE_LIMIT_WINDOW_MS;
}

function recordDelivery(destination: string, eventType: string): void {
  rateLimitStore.set(`${destination}:${eventType}`, { lastSentAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Provider guards
// ---------------------------------------------------------------------------

/** Returns true if SendGrid is configured. */
export function isEmailEnabled(): boolean {
  const hasSendGrid = Boolean(process.env.SENDGRID_API_KEY);
  const hasLegacy = Boolean(process.env.NOTIFICATION_EMAIL_API_URL);
  if (!hasSendGrid && !hasLegacy) {
    console.warn(
      "[NotificationService] EMAIL channel called but no provider is configured. " +
        "Set SENDGRID_API_KEY (recommended) or NOTIFICATION_EMAIL_API_URL."
    );
    return false;
  }
  return true;
}

/** Returns true if Twilio is configured. */
export function isSmsEnabled(): boolean {
  const hasTwilio =
    Boolean(process.env.TWILIO_ACCOUNT_SID) &&
    Boolean(process.env.TWILIO_AUTH_TOKEN);
  const hasLegacy = Boolean(process.env.NOTIFICATION_SMS_API_URL);
  if (!hasTwilio && !hasLegacy) {
    console.warn(
      "[NotificationService] SMS channel called but no provider is configured. " +
        "Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (recommended) or NOTIFICATION_SMS_API_URL."
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// SendGrid provider
// ---------------------------------------------------------------------------

/**
 * Deliver a single email via the SendGrid v3 Mail Send API.
 * Uses axios directly (no SDK dependency) so no extra package is required.
 */
async function sendViaSendGrid(
  to: string,
  subject: string,
  textBody: string,
  htmlBody: string
): Promise<AttemptResult> {
  const apiKey = process.env.SENDGRID_API_KEY!;
  const from = process.env.NOTIFICATION_FROM_EMAIL ?? "noreply@nova-launch.app";

  try {
    const res = await axios.post(
      "https://api.sendgrid.com/v3/mail/send",
      {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [
          { type: "text/plain", value: textBody },
          { type: "text/html", value: htmlBody },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        // SendGrid returns 202 Accepted on success
        validateStatus: () => true,
      }
    );

    const success = res.status >= 200 && res.status < 300;
    return {
      success,
      statusCode: res.status,
      error: success ? null : `SendGrid returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      success: false,
      statusCode: null,
      error: err instanceof Error ? err.message : "SendGrid network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Legacy generic HTTP email provider
// ---------------------------------------------------------------------------

async function sendViaEmailApi(
  to: string,
  subject: string,
  body: string
): Promise<AttemptResult> {
  const emailApiUrl = process.env.NOTIFICATION_EMAIL_API_URL!;
  const emailApiKey = process.env.NOTIFICATION_EMAIL_API_KEY ?? "";

  try {
    const res = await axios.post(
      emailApiUrl,
      { to, subject, body, metadata: {} },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          ...(emailApiKey ? { Authorization: `Bearer ${emailApiKey}` } : {}),
        },
        validateStatus: () => true,
      }
    );

    const success = res.status >= 200 && res.status < 300;
    return {
      success,
      statusCode: res.status,
      error: success ? null : `Email API returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      success: false,
      statusCode: null,
      error: err instanceof Error ? err.message : "Email API network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Twilio provider
// ---------------------------------------------------------------------------

/**
 * Deliver a single SMS via the Twilio Messages REST API.
 * Uses axios with HTTP Basic auth — no SDK dependency.
 */
async function sendViaTwilio(
  to: string,
  body: string
): Promise<AttemptResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_PHONE_NUMBER ?? "";

  try {
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        auth: { username: accountSid, password: authToken },
        validateStatus: () => true,
      }
    );

    const success = res.status >= 200 && res.status < 300;
    return {
      success,
      statusCode: res.status,
      error: success
        ? null
        : `Twilio returned HTTP ${res.status}: ${res.data?.message ?? ""}`,
    };
  } catch (err) {
    return {
      success: false,
      statusCode: null,
      error: err instanceof Error ? err.message : "Twilio network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Legacy generic HTTP SMS provider
// ---------------------------------------------------------------------------

async function sendViaSmsApi(
  to: string,
  message: string
): Promise<AttemptResult> {
  const smsApiUrl = process.env.NOTIFICATION_SMS_API_URL!;
  const smsApiKey = process.env.NOTIFICATION_SMS_API_KEY ?? "";

  try {
    const res = await axios.post(
      smsApiUrl,
      { to, message, metadata: {} },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          ...(smsApiKey ? { Authorization: `Bearer ${smsApiKey}` } : {}),
        },
        validateStatus: () => true,
      }
    );

    const success = res.status >= 200 && res.status < 300;
    return {
      success,
      statusCode: res.status,
      error: success ? null : `SMS API returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      success: false,
      statusCode: null,
      error: err instanceof Error ? err.message : "SMS API network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

type NotificationHandler = (
  target: NotificationTarget,
  payload: NotificationPayload,
  correlationId?: string
) => Promise<NotificationResult>;

// ---------------------------------------------------------------------------
// Circuit breaker integration
//
// WebhookRetryService already retries each delivery with exponential
// backoff (skipping non-retryable statuses); the circuit breaker sits one
// level up and reacts to a *delivery* failing after retries are exhausted,
// rather than to each individual HTTP attempt. When the breaker is open,
// the provider is not called at all — the operation fails fast.
// ---------------------------------------------------------------------------

/** Carries a fully-exhausted retry outcome through a thrown error so the
 * circuit breaker observes the failure without losing the original outcome. */
class DeliveryAttemptsExhaustedError extends Error {
  constructor(readonly outcome: RetryOutcome) {
    super(outcome.lastError ?? "Delivery failed after all retry attempts");
  }
}

async function runWithBreakerAndRetry(
  breaker: CircuitBreaker,
  retryService: WebhookRetryService,
  attemptFn: (attempt: number) => Promise<AttemptResult>
): Promise<RetryOutcome> {
  try {
    return await breaker.execute(async () => {
      const outcome = await retryService.execute(attemptFn);
      if (!outcome.success) {
        throw new DeliveryAttemptsExhaustedError(outcome);
      }
      return outcome;
    });
  } catch (error) {
    if (error instanceof DeliveryAttemptsExhaustedError) {
      return error.outcome;
    }
    if (error instanceof CircuitBreakerOpenError) {
      return {
        success: false,
        attempts: 0,
        totalDurationMs: 0,
        lastStatusCode: null,
        lastError: error.message,
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

export class NotificationService {
  private readonly handlers = new Map<NotificationChannelType, NotificationHandler>();
  private readonly sendGridBreaker: CircuitBreaker;
  private readonly twilioBreaker: CircuitBreaker;

  constructor() {
    this.registerChannel("WEBHOOK", this.sendWebhookNotification.bind(this));
    this.registerChannel("EMAIL", this.sendEmailNotification.bind(this));
    this.registerChannel("SMS", this.sendSmsNotification.bind(this));

    this.sendGridBreaker = new CircuitBreaker({
      failureThreshold: 5,
      successThreshold: 2,
      timeoutMs: 30000,
    });
    this.twilioBreaker = new CircuitBreaker({
      failureThreshold: 5,
      successThreshold: 2,
      timeoutMs: 30000,
    });
    registerCircuitBreaker("sendgrid", this.sendGridBreaker);
    registerCircuitBreaker("twilio", this.twilioBreaker);
  }

  /**
   * Register a channel handler.
   * Throws if the channel is already registered — do not call twice.
   */
  registerChannel(channel: NotificationChannelType, handler: NotificationHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(
        `Notification channel handler already registered for ${channel}`
      );
    }
    this.handlers.set(channel, handler);
  }

  /** Send a notification to one or more targets. */
  async send(request: NotificationRequest): Promise<NotificationResult[]> {
    if (!request.targets || request.targets.length === 0) {
      throw new Error("Notification request requires at least one target");
    }
    if (!request.payload || !request.payload.message) {
      throw new Error("Notification payload.message is required");
    }

    return Promise.all(
      request.targets.map((target) =>
        this.sendToTarget(target, request.payload, request.correlationId)
      )
    );
  }

  private async sendToTarget(
    target: NotificationTarget,
    payload: NotificationPayload,
    correlationId?: string
  ): Promise<NotificationResult> {
    const handler = this.handlers.get(target.type);
    if (!handler) {
      return {
        channel: target.type,
        target,
        provider: target.provider ?? "unknown",
        success: false,
        error: `Unsupported notification channel: ${target.type}`,
      };
    }

    try {
      const result = await handler(target, payload, correlationId);
      IntegrationMetrics.recordNotificationDelivery(
        target.type,
        result.success ? "success" : "failed"
      );
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      IntegrationMetrics.recordNotificationDelivery(target.type, "failed");
      return {
        channel: target.type,
        target,
        provider: target.provider ?? "default",
        success: false,
        error: message,
      };
    }
  }

  // ── WEBHOOK ──────────────────────────────────────────────────────────────

  private async sendWebhookNotification(
    target: NotificationTarget,
    payload: NotificationPayload,
    correlationId?: string
  ): Promise<NotificationResult> {
    if (!payload.event) {
      return {
        channel: "WEBHOOK",
        target,
        provider: "webhook",
        success: false,
        error: "Webhook notifications require payload.event",
      };
    }

    await webhookDeliveryService.triggerEvent(
      payload.event,
      payload as any,
      payload.tokenAddress,
      correlationId
    );

    return { channel: "WEBHOOK", target, provider: "webhook", success: true };
  }

  // ── EMAIL ─────────────────────────────────────────────────────────────────

  private async sendEmailNotification(
    target: NotificationTarget,
    payload: NotificationPayload
  ): Promise<NotificationResult> {
    if (!target.destination) {
      return {
        channel: "EMAIL",
        target,
        provider: "email",
        success: false,
        error: "Email notifications require a destination email address",
      };
    }

    if (!isEmailEnabled()) {
      return {
        channel: "EMAIL",
        target,
        provider: "email",
        success: false,
        error: "Email channel is not configured",
      };
    }

    // Rate-limit guard
    const eventKey = String(payload.event ?? payload.subject ?? "generic");
    if (isRateLimited(target.destination, eventKey)) {
      console.info(
        `[NotificationService] EMAIL rate-limited for ${maskDestination(target.destination)} event=${eventKey}`
      );
      return {
        channel: "EMAIL",
        target,
        provider: "email",
        success: false,
        error: "Rate limit exceeded — notification suppressed",
      };
    }

    const subject = payload.subject ?? "Nova Launch Notification";
    const templateKey = payload.metadata?.templateKey as EmailTemplateKey | undefined;
    const templateVars: Record<string, string> = {
      message: payload.message,
      ...(payload.tokenAddress ? { tokenAddress: payload.tokenAddress } : {}),
      unsubscribeUrl: "https://nova-launch.app/unsubscribe",
      actionUrl: "https://nova-launch.app",
      ...(payload.metadata as Record<string, string> | undefined ?? {}),
    };
    const htmlBody = templateKey
      ? renderTemplate(templateKey, templateVars)
      : payload.message;

    const retryService = new WebhookRetryService(
      { maxAttempts: MAX_RETRIES, jitter: true },
      // Instant delay in test environments to keep suites fast
      process.env.NODE_ENV === "test"
        ? () => Promise.resolve()
        : undefined
    );

    const useSendGrid = Boolean(process.env.SENDGRID_API_KEY);
    const outcome = await runWithBreakerAndRetry(this.sendGridBreaker, retryService, async () => {
      if (useSendGrid) {
        return sendViaSendGrid(target.destination!, subject, payload.message, htmlBody);
      }
      return sendViaEmailApi(target.destination!, subject, payload.message);
    });

    if (outcome.success) {
      recordDelivery(target.destination, eventKey);
      console.info(
        `[NotificationService] EMAIL delivered to ${maskDestination(target.destination)} ` +
          `event=${eventKey} attempts=${outcome.attempts}`
      );
    } else {
      console.warn(
        `[NotificationService] EMAIL delivery failed for ${maskDestination(target.destination)} ` +
          `event=${eventKey} attempts=${outcome.attempts} error=${outcome.lastError}`
      );
    }

    return {
      channel: "EMAIL",
      target,
      provider: useSendGrid ? "sendgrid" : "email",
      success: outcome.success,
      error: outcome.success ? null : (outcome.lastError ?? "Unknown email error"),
    };
  }

  // ── SMS ───────────────────────────────────────────────────────────────────

  private async sendSmsNotification(
    target: NotificationTarget,
    payload: NotificationPayload
  ): Promise<NotificationResult> {
    if (!target.destination) {
      return {
        channel: "SMS",
        target,
        provider: "sms",
        success: false,
        error: "SMS notifications require a destination phone number",
      };
    }

    if (!isSmsEnabled()) {
      return {
        channel: "SMS",
        target,
        provider: "sms",
        success: false,
        error: "SMS channel is not configured",
      };
    }

    // Rate-limit guard
    const eventKey = String(payload.event ?? payload.subject ?? "generic");
    if (isRateLimited(target.destination, eventKey)) {
      console.info(
        `[NotificationService] SMS rate-limited for ${maskDestination(target.destination)} event=${eventKey}`
      );
      return {
        channel: "SMS",
        target,
        provider: "sms",
        success: false,
        error: "Rate limit exceeded — notification suppressed",
      };
    }

    const retryService = new WebhookRetryService(
      { maxAttempts: MAX_RETRIES, jitter: true },
      process.env.NODE_ENV === "test" ? () => Promise.resolve() : undefined
    );

    const useTwilio =
      Boolean(process.env.TWILIO_ACCOUNT_SID) &&
      Boolean(process.env.TWILIO_AUTH_TOKEN);

    const outcome = await runWithBreakerAndRetry(this.twilioBreaker, retryService, async () => {
      if (useTwilio) {
        return sendViaTwilio(target.destination!, payload.message);
      }
      return sendViaSmsApi(target.destination!, payload.message);
    });

    if (outcome.success) {
      recordDelivery(target.destination, eventKey);
      console.info(
        `[NotificationService] SMS delivered to ${maskDestination(target.destination)} ` +
          `event=${eventKey} attempts=${outcome.attempts}`
      );
    } else {
      console.warn(
        `[NotificationService] SMS delivery failed for ${maskDestination(target.destination)} ` +
          `event=${eventKey} attempts=${outcome.attempts} error=${outcome.lastError}`
      );
    }

    return {
      channel: "SMS",
      target,
      provider: useTwilio ? "twilio" : "sms",
      success: outcome.success,
      error: outcome.success ? null : (outcome.lastError ?? "Unknown SMS error"),
    };
  }
}

export default new NotificationService();
