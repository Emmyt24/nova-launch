import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  prepareCustomHeaders,
  resolveCustomHeaders,
  maskCustomHeaders,
  isBlockedHeaderName,
  CustomHeaderValidationError,
  MASKED_VALUE,
  MAX_CUSTOM_HEADERS,
} from "../services/webhookCustomHeaders";
import {
  encryptHeaderValue,
  decryptHeaderValue,
  isEncryptedValue,
} from "../utils/headerEncryption";
import { WebhookEventType, WebhookSubscription } from "../types/webhook";

const { axiosPost } = vi.hoisted(() => ({ axiosPost: vi.fn() }));

vi.mock("axios", () => ({ default: { post: axiosPost } }));

vi.mock("../database/db", () => ({ default: { query: vi.fn() } }));

vi.mock("../middleware/rateLimiter", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  webhookRateLimiter: vi.fn((_req, _res, next) => next()),
  webhookUserRateLimiter: vi.fn((_req, _res, next) => next()),
}));

const KEY = "a".repeat(64);
const OWNER = "G" + "B".repeat(55);
const SUB_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEBHOOK_HEADER_ENCRYPTION_KEY = KEY;
});

afterEach(() => {
  delete process.env.WEBHOOK_HEADER_ENCRYPTION_KEY;
});

describe("headerEncryption", () => {
  it("round-trips values with AES-256-GCM", () => {
    const encrypted = encryptHeaderValue("Bearer abc", KEY);
    expect(isEncryptedValue(encrypted)).toBe(true);
    expect(encrypted).not.toContain("Bearer abc");
    expect(decryptHeaderValue(encrypted, KEY)).toBe("Bearer abc");
  });

  it("uses a random IV so equal values encrypt differently", () => {
    expect(encryptHeaderValue("same", KEY)).not.toBe(encryptHeaderValue("same", KEY));
  });

  it("fails to decrypt with the wrong key or tampered ciphertext", () => {
    const encrypted = encryptHeaderValue("secret", KEY);
    expect(() => decryptHeaderValue(encrypted, "b".repeat(64))).toThrow();
    const tampered = encrypted.slice(0, -2) + (encrypted.endsWith("A") ? "B" : "A") + "=";
    expect(() => decryptHeaderValue(tampered, KEY)).toThrow();
  });

  it("requires a key to encrypt", () => {
    expect(() => encryptHeaderValue("x", undefined)).toThrow(/WEBHOOK_HEADER_ENCRYPTION_KEY/);
  });
});

describe("prepareCustomHeaders", () => {
  it("accepts valid headers and stores non-sensitive values in plain text", () => {
    expect(prepareCustomHeaders([{ name: "X-Tenant", value: "acme" }])).toEqual([
      { name: "X-Tenant", value: "acme", sensitive: false },
    ]);
  });

  it("returns an empty list when headers are omitted", () => {
    expect(prepareCustomHeaders(undefined)).toEqual([]);
    expect(prepareCustomHeaders(null)).toEqual([]);
  });

  it("encrypts sensitive values detected by name or flagged explicitly", () => {
    const stored = prepareCustomHeaders([
      { name: "Authorization", value: "Bearer abc" },
      { name: "X-Api-Key", value: "k-123" },
      { name: "X-Gateway-Id", value: "gw-1", sensitive: true },
    ]);

    for (const header of stored) {
      expect(header.sensitive).toBe(true);
      expect(isEncryptedValue(header.value)).toBe(true);
    }
    expect(decryptHeaderValue(stored[0].value)).toBe("Bearer abc");
  });

  it.each([
    "Connection",
    "keep-alive",
    "Transfer-Encoding",
    "Upgrade",
    "TE",
    "Trailer",
    "Proxy-Authorization",
    "Host",
    "Content-Length",
    "Content-Type",
    "Content-Encoding",
    "User-Agent",
    "X-Webhook-Signature",
    "x-webhook-event",
    "X-Correlation-Id",
    "X-Nova-Anything",
  ])("blocks reserved or hop-by-hop header %s", (name) => {
    expect(isBlockedHeaderName(name)).toBe(true);
    expect(() => prepareCustomHeaders([{ name, value: "v" }])).toThrow(
      CustomHeaderValidationError
    );
  });

  it("rejects invalid names, CRLF injection, duplicates and too many headers", () => {
    expect(() => prepareCustomHeaders([{ name: "Bad Name", value: "v" }])).toThrow(
      /Invalid header name/
    );
    expect(() => prepareCustomHeaders([{ name: "X-A", value: "v\r\nX-Evil: 1" }])).toThrow(
      /invalid characters/
    );
    expect(() =>
      prepareCustomHeaders([
        { name: "X-A", value: "1" },
        { name: "x-a", value: "2" },
      ])
    ).toThrow(/Duplicate/);
    expect(() =>
      prepareCustomHeaders(
        Array.from({ length: MAX_CUSTOM_HEADERS + 1 }, (_, i) => ({ name: `X-H${i}`, value: "v" }))
      )
    ).toThrow(/At most/);
    expect(() => prepareCustomHeaders("nope")).toThrow(/must be an array/);
    expect(() => prepareCustomHeaders([{ name: "X-A", value: 5 }])).toThrow(/must be a string/);
  });
});

describe("resolveCustomHeaders / maskCustomHeaders", () => {
  it("decrypts sensitive values for delivery and masks them for the API", () => {
    const stored = prepareCustomHeaders([
      { name: "Authorization", value: "Bearer abc" },
      { name: "X-Tenant", value: "acme" },
    ]);

    expect(resolveCustomHeaders(stored)).toEqual({
      Authorization: "Bearer abc",
      "X-Tenant": "acme",
    });
    expect(maskCustomHeaders(stored)).toEqual([
      { name: "Authorization", value: MASKED_VALUE, sensitive: true },
      { name: "X-Tenant", value: "acme", sensitive: false },
    ]);
  });

  it("skips blocked headers even if they were stored", () => {
    expect(
      resolveCustomHeaders([{ name: "Host", value: "evil.example", sensitive: false }])
    ).toEqual({});
  });
});

describe("WebhookService custom headers persistence", () => {
  it("stores encrypted headers on create", async () => {
    const db = await import("../database/db");
    vi.mocked(db.default.query).mockImplementation(async (_sql, params: any) => ({
      rows: [
        {
          id: params[0],
          url: params[1],
          token_address: null,
          events: params[3],
          secret: params[4],
          active: true,
          created_by: params[5],
          created_at: new Date(),
          last_triggered: null,
          custom_headers: JSON.parse(params[6]),
        },
      ],
      rowCount: 1,
    }) as any);

    const { WebhookService } = await import("../services/webhookService");
    const sub = await new WebhookService().createSubscription({
      url: "https://example.com/hook",
      events: [WebhookEventType.TOKEN_CREATED],
      createdBy: OWNER,
      customHeaders: [{ name: "Authorization", value: "Bearer abc" }],
    });

    const storedJson = vi.mocked(db.default.query).mock.calls[0][1]![6] as string;
    expect(storedJson).not.toContain("Bearer abc");
    expect(sub.customHeaders?.[0].sensitive).toBe(true);
    expect(resolveCustomHeaders(sub.customHeaders)).toEqual({ Authorization: "Bearer abc" });
  });

  it("rejects blocked headers before touching the database", async () => {
    const db = await import("../database/db");
    const { WebhookService } = await import("../services/webhookService");

    await expect(
      new WebhookService().updateCustomHeaders(SUB_ID, OWNER, [{ name: "Connection", value: "close" }])
    ).rejects.toBeInstanceOf(CustomHeaderValidationError);
    expect(db.default.query).not.toHaveBeenCalled();
  });
});

describe("delivery with custom headers", () => {
  it("sends decrypted custom headers without overriding pipeline headers", async () => {
    const db = await import("../database/db");
    vi.mocked(db.default.query).mockResolvedValue({ rows: [], rowCount: 1 } as any);
    axiosPost.mockResolvedValue({ status: 200 });

    const { WebhookDeliveryService } = await import("../services/webhookDeliveryService");
    const service = new WebhookDeliveryService({ acquire: vi.fn().mockResolvedValue(undefined) } as any);
    vi.spyOn(service as any, "isWithinTenantRateLimit").mockResolvedValue(true);

    const subscription: WebhookSubscription = {
      id: SUB_ID,
      url: "https://receiver.example.com/hook",
      tokenAddress: null,
      events: [WebhookEventType.TOKEN_CREATED],
      secret: "secret",
      active: true,
      createdBy: OWNER,
      createdAt: new Date(),
      lastTriggered: null,
      customHeaders: [
        ...prepareCustomHeaders([
          { name: "Authorization", value: "Bearer abc" },
          { name: "X-Tenant", value: "acme" },
        ]),
        // Simulates a row written before validation existed.
        { name: "X-Webhook-Signature", value: "forged", sensitive: false },
      ],
    };

    await service.deliverWebhook(
      subscription,
      WebhookEventType.TOKEN_CREATED,
      {
        tokenAddress: "GTOKEN",
        creator: OWNER,
        name: "Nova",
        symbol: "NOVA",
        decimals: 7,
        initialSupply: "1",
        transactionHash: "tx",
        ledger: 1,
      },
      "cid"
    );

    const headers = axiosPost.mock.calls[0][2].headers;
    expect(headers.Authorization).toBe("Bearer abc");
    expect(headers["X-Tenant"]).toBe("acme");
    expect(headers["X-Webhook-Signature"]).not.toBe("forged");
    expect(headers["X-Webhook-Signature"]).toMatch(/^v1\./);
  });
});

describe("PUT /api/webhooks/:id/headers", () => {
  async function app() {
    const { default: router } = await import("../routes/webhooks");
    const instance = express();
    instance.use(express.json());
    instance.use("/api/webhooks", router);
    return instance;
  }

  it("updates headers and returns masked values", async () => {
    const db = await import("../database/db");
    vi.mocked(db.default.query).mockImplementation(async (_sql, params: any) => ({
      rows: [{ id: SUB_ID, custom_headers: JSON.parse(params[0]) }],
      rowCount: 1,
    }) as any);

    const res = await request(await app())
      .put(`/api/webhooks/${SUB_ID}/headers`)
      .send({ createdBy: OWNER, customHeaders: [{ name: "Authorization", value: "Bearer abc" }] });

    expect(res.status).toBe(200);
    expect(res.body.data.customHeaders).toEqual([
      { name: "Authorization", value: MASKED_VALUE, sensitive: true },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("Bearer abc");
  });

  it("returns 400 for blocked headers", async () => {
    const res = await request(await app())
      .put(`/api/webhooks/${SUB_ID}/headers`)
      .send({ createdBy: OWNER, customHeaders: [{ name: "Transfer-Encoding", value: "chunked" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reserved or hop-by-hop/);
  });

  it("returns 404 when the subscription is missing or not owned", async () => {
    const db = await import("../database/db");
    vi.mocked(db.default.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);

    const res = await request(await app())
      .put(`/api/webhooks/${SUB_ID}/headers`)
      .send({ createdBy: OWNER, customHeaders: [] });

    expect(res.status).toBe(404);
  });

  it("requires createdBy and an array", async () => {
    const instance = await app();
    expect(
      (await request(instance).put(`/api/webhooks/${SUB_ID}/headers`).send({ customHeaders: [] })).status
    ).toBe(400);
    expect(
      (await request(instance).put(`/api/webhooks/${SUB_ID}/headers`).send({ createdBy: OWNER })).status
    ).toBe(400);
  });
});
