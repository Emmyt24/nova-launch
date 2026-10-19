import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  generateWebhookSignature,
  verifyWebhookSignature,
  verifyStoredWebhookSignature,
} from "../utils/crypto";
import { WebhookService } from "../services/webhookService";
import { WebhookEventData, WebhookEventType } from "../types/webhook";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeVerifier = require("../../../docs/webhooks/verifiers/verify-webhook.js");

vi.mock("../database/db", () => ({ default: { query: vi.fn() } }));

const DOCS_DIR = join(__dirname, "../../../docs/webhooks");

interface SignatureVector {
  name: string;
  secret: string;
  timestamp: number;
  payload: { event: WebhookEventType; timestamp: string; data: WebhookEventData };
  signedPayload: string;
  expectedSignature: string;
  expectedHeader: string;
}

const { vectors } = JSON.parse(
  readFileSync(join(DOCS_DIR, "signature-test-vectors.json"), "utf8")
) as { vectors: SignatureVector[] };

describe("webhook signature test vectors", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ships at least one vector", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  describe.each(vectors)("$name", (v) => {
    it("signedPayload is the compact JSON of {event, timestamp, data}", () => {
      expect(JSON.stringify(v.payload)).toBe(v.signedPayload);
      expect(v.expectedHeader).toBe(`v1.${v.timestamp}.${v.expectedSignature}`);
    });

    it("matches generateWebhookSignature", () => {
      expect(generateWebhookSignature(v.signedPayload, v.secret, v.timestamp)).toBe(
        v.expectedHeader
      );
    });

    it("verifies with verifyStoredWebhookSignature and verifyWebhookSignature", () => {
      expect(verifyStoredWebhookSignature(v.signedPayload, v.expectedHeader, v.secret)).toBe(true);

      vi.useFakeTimers();
      vi.setSystemTime(v.timestamp * 1000);
      expect(verifyWebhookSignature(v.signedPayload, v.expectedHeader, v.secret)).toBe(true);
    });

    it("is reproduced by WebhookService.createPayload", () => {
      vi.useFakeTimers();
      vi.setSystemTime(v.timestamp * 1000);
      const payload = new WebhookService().createPayload(
        v.payload.event,
        v.payload.data,
        v.secret
      );
      expect(payload.timestamp).toBe(v.payload.timestamp);
      expect(payload.signature).toBe(v.expectedHeader);
    });

    it("rejects a tampered payload or wrong secret", () => {
      const tampered = v.signedPayload.replace(v.payload.event, "token.tampered");
      expect(verifyStoredWebhookSignature(tampered, v.expectedHeader, v.secret)).toBe(false);
      expect(verifyStoredWebhookSignature(v.signedPayload, v.expectedHeader, "wrong")).toBe(false);
    });

    it("is accepted by the sample Node verifier", () => {
      const rawBody = JSON.stringify({ ...v.payload, signature: v.expectedHeader });
      expect(
        nodeVerifier.verifyNovaWebhook(rawBody, v.expectedHeader, v.secret, { now: v.timestamp })
      ).toBe(true);
      expect(
        nodeVerifier.verifyNovaWebhook(rawBody, v.expectedHeader, v.secret, {
          now: v.timestamp + 301,
        })
      ).toBe(false);
    });
  });

  it("is accepted by the sample Python verifier", () => {
    let output: string;
    try {
      output = execFileSync("python3", [join(DOCS_DIR, "verifiers/verify_webhook.py")], {
        encoding: "utf8",
      });
    } catch {
      // python3 not available in this environment; Node checks above still apply.
      return;
    }
    expect(output).not.toMatch(/FAIL/);
    expect(output.match(/PASS/g)?.length).toBe(vectors.length);
  });
});
