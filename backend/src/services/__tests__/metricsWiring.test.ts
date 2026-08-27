import { describe, it, expect } from "vitest";
import { IntegrationMetrics, register } from "../../lib/metrics";

/**
 * stellarEventListener.ts, notificationService.ts, and webhookDeliveryService.ts
 * previously imported IntegrationMetrics from a dead no-op stub
 * (monitoring/metrics/prometheus-config.ts), so none of these calls ever
 * reached a real metric. These tests call IntegrationMetrics exactly the way
 * each service does and assert the series actually lands in the real
 * Prometheus registry from lib/metrics.
 */
describe("IntegrationMetrics wiring — real registry", () => {
  it("stellarEventListener: recordIngestionLag/recordEventProcessed reach the registry", async () => {
    const eventType = "wiring_test_token_created";
    IntegrationMetrics.recordIngestionLag(
      eventType,
      new Date(Date.now() - 2000).toISOString()
    );
    IntegrationMetrics.recordEventProcessed(eventType, "success");

    const output = await register.metrics();
    expect(output).toContain("event_ingestion_lag_seconds");
    expect(output).toContain(`event_type="${eventType}"`);
    expect(output).toMatch(
      new RegExp(`events_processed_total\\{[^}]*event_type="${eventType}"[^}]*status="success"[^}]*\\} 1`)
    );
  });

  it("webhookDeliveryService: recordWebhookDelivery/recordWebhookDeadLetter reach the registry", async () => {
    const eventType = "wiring_test_webhook_event";
    IntegrationMetrics.recordWebhookDelivery(eventType, "exhausted", 1200, 2);
    IntegrationMetrics.recordWebhookDeadLetter(eventType);

    const output = await register.metrics();
    expect(output).toMatch(
      new RegExp(`webhook_deliveries_total\\{[^}]*status="failure"[^}]*event_type="${eventType}"[^}]*\\} 1`)
    );
    expect(output).toMatch(
      new RegExp(`webhook_retries_total\\{[^}]*event_type="${eventType}"[^}]*\\} 2`)
    );
    expect(output).toMatch(
      new RegExp(`webhook_dead_letters_total\\{[^}]*event_type="${eventType}"[^}]*\\} 1`)
    );
  });

  it("notificationService: recordNotificationDelivery reaches the registry", async () => {
    const channel = "wiring_test_email";
    IntegrationMetrics.recordNotificationDelivery(channel, "success");

    const output = await register.metrics();
    expect(output).toMatch(
      new RegExp(`notification_deliveries_total\\{[^}]*channel="${channel}"[^}]*status="success"[^}]*\\} 1`)
    );
  });
});
