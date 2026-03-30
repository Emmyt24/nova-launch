import axios, { AxiosError } from "axios";
import {
  WebhookSubscription,
  WebhookPayload,
  WebhookEventType,
  WebhookEventData,
} from "../types/webhook";
import webhookService from "./webhookService";

const TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || "5000");
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || "3");
const RETRY_DELAY_MS = parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || "1000");

export class WebhookDeliveryService {
  /**
   * Trigger webhooks for an event
   */
  async triggerEvent(
    event: WebhookEventType,
    data: WebhookEventData,
    tokenAddress?: string,
    correlationId?: string
  ): Promise<void> {
    const subscriptions = await webhookService.findMatchingSubscriptions(
      event,
      tokenAddress
    );

    const cid = correlationId || `whk_${Date.now().toString(36)}`;
    console.log(
      JSON.stringify({ event: 'webhook.trigger', correlationId: cid, webhookEvent: event, subscriptionCount: subscriptions.length })
    );

    // Deliver webhooks in parallel
    await Promise.allSettled(
      subscriptions.map((subscription) =>
        this.deliverWebhook(subscription, event, data, cid)
      )
    );
  }

  /**
   * Deliver webhook to a single subscription with retry logic
   * @internal
   */
  async deliverWebhook(
    subscription: WebhookSubscription,
    event: WebhookEventType,
    data: WebhookEventData,
    correlationId?: string
  ): Promise<void> {
    const payload = webhookService.createPayload(
      event,
      data,
      subscription.secret
    );

    const cid = correlationId || `whk_${Date.now().toString(36)}`;
    // Attach correlation ID to payload headers (not body — body is signed)
    const extraHeaders: Record<string, string> = {
      'X-Correlation-Id': cid,
    };
    // Include originating tx hash if present in data
    const txHash = (data as Record<string, unknown>).transactionHash as string | undefined;
    if (txHash) extraHeaders['X-Tx-Hash'] = txHash;

    let lastError: string | null = null;
    let statusCode: number | null = null;
    let success = false;
    let attempts = 0;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      attempts = attempt;
      try {
        console.log(
          JSON.stringify({ event: 'webhook.attempt', correlationId: cid, url: subscription.url, attempt, maxRetries: MAX_RETRIES, ...(txHash && { txHash }) })
        );

        const response = await axios.post(subscription.url, payload, {
          timeout: TIMEOUT_MS,
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": payload.signature,
            "X-Webhook-Event": event,
            "User-Agent": "Nova-Launch-Webhook/1.0",
            ...extraHeaders,
          },
          validateStatus: (status) => status >= 200 && status < 300,
        });

        statusCode = response.status;
        success = true;
        lastError = null;

        console.log(
          JSON.stringify({ event: 'webhook.delivered', correlationId: cid, url: subscription.url, statusCode, ...(txHash && { txHash }) })
        );

        // Update last triggered timestamp
        await webhookService.updateLastTriggered(subscription.id);

        break; // Success, exit retry loop
      } catch (error) {
        const axiosError = error as AxiosError;
        statusCode = axiosError.response?.status || null;
        lastError = axiosError.message;

        console.error(
          JSON.stringify({ event: 'webhook.failed', correlationId: cid, url: subscription.url, attempt, statusCode, error: lastError, ...(txHash && { txHash }) })
        );

        // 4xx errors are non-retryable — stop immediately
        if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
          break;
        }

        // Wait before retrying (exponential backoff)
        if (attempt < MAX_RETRIES) {
          await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
        }
      }
    }

    // Log the delivery attempt
    await webhookService.logDelivery(
      subscription.id,
      event,
      payload,
      statusCode,
      success,
      attempts,
      lastError
    );

    if (!success) {
      console.warn(
        JSON.stringify({ event: 'webhook.exhausted', correlationId: cid, subscriptionId: subscription.id, attempts: MAX_RETRIES, ...(txHash && { txHash }) })
      );
    }
  }

  /**
   * Delay helper for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Test webhook delivery (for testing endpoints)
   */
  async testWebhook(subscription: WebhookSubscription): Promise<boolean> {
    const testPayload = webhookService.createPayload(
      WebhookEventType.TOKEN_CREATED,
      {
        tokenAddress: "GTEST...",
        creator: "GTEST...",
        name: "Test Token",
        symbol: "TEST",
        decimals: 7,
        initialSupply: "1000000",
        transactionHash: "test-hash",
        ledger: 12345,
      },
      subscription.secret
    );

    try {
      const response = await axios.post(subscription.url, testPayload, {
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": testPayload.signature,
          "X-Webhook-Event": "test",
          "User-Agent": "Nova-Launch-Webhook/1.0",
        },
      });

      return response.status >= 200 && response.status < 300;
    } catch (error) {
      console.error("Test webhook failed:", error);
      return false;
    }
  }
}

export default new WebhookDeliveryService();
