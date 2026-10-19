import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyPayloadSizeLimit,
  buildFullDataUrl,
  getMaxPayloadBytes,
  measurePayloadBytes,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from "../services/webhookPayloadLimit";
import {
  WebhookEventType,
  WebhookSubscription,
  MetadataUpdatedEventData,
  TruncatedEventData,
} from "../types/webhook";

const { axiosPost, createPayload } = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  createPayload: vi.fn(),
}));

vi.mock("axios", () => ({ default: { post: axiosPost } }));

vi.mock("../services/webhookService", () => ({
  default: {
    createPayload,
    updateLastTriggered: vi.fn().mockResolvedValue(undefined),
    logDelivery: vi.fn().mockResolvedValue(undefined),
    findMatchingSubscriptions: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../services/webhookDeadLetterService", () => ({
  default: { storeDeadLetter: vi.fn().mockResolvedValue("dl-1") },
}));

const baseData: MetadataUpdatedEventData = {
  tokenAddress: "GTOKEN",
  metadataUri: "ipfs://bafy",
  updatedBy: "GADMIN",
  transactionHash: "tx-123",
  ledger: 42,
};

describe("webhookPayloadLimit", () => {
  it("defaults to 256 KiB and honours WEBHOOK_MAX_PAYLOAD_BYTES", () => {
    expect(getMaxPayloadBytes(undefined)).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(getMaxPayloadBytes("2048")).toBe(2048);
    expect(getMaxPayloadBytes("not-a-number")).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(getMaxPayloadBytes("0")).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
  });

  it("returns payloads within the limit unchanged", () => {
    const result = applyPayloadSizeLimit(WebhookEventType.TOKEN_METADATA_UPDATED, baseData, {
      maxBytes: 10_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.data).toBe(baseData);
    expect(result.droppedFields).toEqual([]);
  });

  it("drops oversized fields and keeps identifying ones when over the limit", () => {
    const data = { ...baseData, metadataUri: "x".repeat(5000) };
    const result = applyPayloadSizeLimit(WebhookEventType.TOKEN_METADATA_UPDATED, data, {
      maxBytes: 1000,
    });
    const truncated = result.data as TruncatedEventData;

    expect(result.truncated).toBe(true);
    expect(truncated.truncated).toBe(true);
    expect(truncated.metadataUri).toBeUndefined();
    expect(truncated.droppedFields).toEqual(["metadataUri"]);
    expect(truncated.tokenAddress).toBe("GTOKEN");
    expect(truncated.transactionHash).toBe("tx-123");
    expect(truncated.ledger).toBe(42);
    expect(truncated.updatedBy).toBe("GADMIN");
    expect(truncated.originalSizeBytes).toBe(result.originalSizeBytes);
    expect(truncated.maxSizeBytes).toBe(1000);
    expect(result.finalSizeBytes).toBeLessThanOrEqual(1000);
    expect(result.finalSizeBytes).toBe(
      measurePayloadBytes(WebhookEventType.TOKEN_METADATA_UPDATED, result.data)
    );
  });

  it("falls back to identifying fields only when small fields still exceed the limit", () => {
    const many: Record<string, unknown> = { ...baseData };
    for (let i = 0; i < 50; i++) many[`f${i}`] = "y".repeat(200);
    const result = applyPayloadSizeLimit(
      WebhookEventType.TOKEN_METADATA_UPDATED,
      many as unknown as MetadataUpdatedEventData,
      { maxBytes: 1500 }
    );
    const truncated = result.data as TruncatedEventData;

    expect(truncated.f0).toBeUndefined();
    expect(truncated.updatedBy).toBeUndefined();
    expect(truncated.tokenAddress).toBe("GTOKEN");
    expect(truncated.droppedFields).toEqual(expect.arrayContaining(["f0", "f49", "updatedBy"]));
  });

  it("links to the full data when a URL template is configured", () => {
    const data = { ...baseData, metadataUri: "x".repeat(5000) };
    const result = applyPayloadSizeLimit(WebhookEventType.TOKEN_METADATA_UPDATED, data, {
      maxBytes: 1000,
      fullDataUrlTemplate: "https://api.example.com/tx/{transactionHash}?token={tokenAddress}",
    });
    expect((result.data as TruncatedEventData).fullDataUrl).toBe(
      "https://api.example.com/tx/tx-123?token=GTOKEN"
    );
  });

  it("omits the link when a template placeholder is missing from the data", () => {
    expect(buildFullDataUrl("https://x/{missing}", { a: 1 })).toBeUndefined();
    expect(buildFullDataUrl(undefined, { a: 1 })).toBeUndefined();
    expect(buildFullDataUrl("https://x/{a}", { a: "b c" })).toBe("https://x/b%20c");
  });
});

describe("WebhookDeliveryService payload truncation", () => {
  const subscription: WebhookSubscription = {
    id: "sub-1",
    url: "https://receiver.example.com/hook",
    tokenAddress: null,
    events: [WebhookEventType.TOKEN_METADATA_UPDATED],
    secret: "secret",
    active: true,
    createdBy: "GOWNER",
    createdAt: new Date(),
    lastTriggered: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_MAX_PAYLOAD_BYTES = "1000";
    createPayload.mockImplementation((event, data) => ({
      event,
      timestamp: new Date().toISOString(),
      data,
      signature: "v1.0.sig",
    }));
    axiosPost.mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    delete process.env.WEBHOOK_MAX_PAYLOAD_BYTES;
  });

  async function newService() {
    const { WebhookDeliveryService } = await import("../services/webhookDeliveryService");
    const rateLimiter = { acquire: vi.fn().mockResolvedValue(undefined) };
    const service = new WebhookDeliveryService(rateLimiter as any);
    vi.spyOn(service as any, "isWithinTenantRateLimit").mockResolvedValue(true);
    return service;
  }

  it("signs and delivers the truncated data, sets a header and logs the event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = await newService();

    await service.deliverWebhook(
      subscription,
      WebhookEventType.TOKEN_METADATA_UPDATED,
      { ...baseData, metadataUri: "x".repeat(5000) },
      "cid-1"
    );

    const signedData = createPayload.mock.calls[0][1] as TruncatedEventData;
    expect(signedData.truncated).toBe(true);
    expect(signedData.metadataUri).toBeUndefined();

    const headers = axiosPost.mock.calls[0][2].headers;
    expect(headers["X-Webhook-Truncated"]).toBe("true");

    const logged = warn.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0]));
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.event === "webhook.payload_truncated");
    expect(logged).toMatchObject({
      correlationId: "cid-1",
      subscriptionId: "sub-1",
      maxSizeBytes: 1000,
      droppedFields: ["metadataUri"],
    });
    warn.mockRestore();
  });

  it("does not truncate or log for payloads within the limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = await newService();

    await service.deliverWebhook(
      subscription,
      WebhookEventType.TOKEN_METADATA_UPDATED,
      baseData,
      "cid-2"
    );

    expect(createPayload.mock.calls[0][1]).toEqual(baseData);
    expect(axiosPost.mock.calls[0][2].headers["X-Webhook-Truncated"]).toBeUndefined();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("webhook.payload_truncated"))
    ).toBe(false);
    warn.mockRestore();
  });
});
