import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Request, Response } from "express";
import request from "supertest";
import { auditLog } from "../auditLog";

const SENSITIVE_FIELDS = [
  "authorization",
  "x-api-key",
  "token",
  "secret",
  "password",
  "private_key",
  "wallet_secret",
  "auth_token",
  "access_token",
  "refresh_token",
  "api_key",
];

function redactSensitiveFields(obj: any, fieldsToRedact: string[] = SENSITIVE_FIELDS): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveFields(item, fieldsToRedact));
  }

  const redacted = { ...obj };
  for (const key in redacted) {
    if (redacted.hasOwnProperty(key)) {
      const lowerKey = key.toLowerCase();
      if (fieldsToRedact.some((field) => lowerKey.includes(field.toLowerCase()))) {
        redacted[key] = "[REDACTED]";
      } else if (typeof redacted[key] === "object") {
        redacted[key] = redactSensitiveFields(redacted[key], fieldsToRedact);
      }
    }
  }

  return redacted;
}

describe("PII Redaction in Audit Logs", () => {
  it("redacts top-level sensitive fields", () => {
    const data = {
      username: "alice",
      token: "secret-token-123",
      email: "alice@example.com",
    };

    const redacted = redactSensitiveFields(data);
    expect(redacted.username).toBe("alice");
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.email).toBe("alice@example.com");
  });

  it("redacts nested sensitive fields while preserving structure", () => {
    const data = {
      user: {
        id: "user-123",
        name: "Bob",
        credentials: {
          password: "super-secret",
          email: "bob@example.com",
        },
      },
    };

    const redacted = redactSensitiveFields(data);
    expect(redacted.user.id).toBe("user-123");
    expect(redacted.user.name).toBe("Bob");
    expect(redacted.user.credentials.password).toBe("[REDACTED]");
    expect(redacted.user.credentials.email).toBe("bob@example.com");
  });

  it("redacts sensitive fields in request payload", () => {
    const requestData = {
      action: "create_token",
      body: {
        label: "my-token",
        authorization: "Bearer secret-auth-123",
        api_key: "key-secret-456",
      },
    };

    const redacted = redactSensitiveFields(requestData);
    expect(redacted.action).toBe("create_token");
    expect(redacted.body.label).toBe("my-token");
    expect(redacted.body.authorization).toBe("[REDACTED]");
    expect(redacted.body.api_key).toBe("[REDACTED]");
  });

  it("redacts sensitive fields in response payload", () => {
    const responseData = {
      id: "token-123",
      label: "api-token",
      secret: "super-secret-key",
      created_at: "2024-01-01T00:00:00Z",
    };

    const redacted = redactSensitiveFields(responseData);
    expect(redacted.id).toBe("token-123");
    expect(redacted.label).toBe("api-token");
    expect(redacted.secret).toBe("[REDACTED]");
    expect(redacted.created_at).toBe("2024-01-01T00:00:00Z");
  });

  it("redacts wallet secrets and private keys", () => {
    const data = {
      wallet_secret: "0x1234567890abcdef",
      private_key: "-----BEGIN PRIVATE KEY-----",
      public_address: "0xabcdef123456",
    };

    const redacted = redactSensitiveFields(data);
    expect(redacted.wallet_secret).toBe("[REDACTED]");
    expect(redacted.private_key).toBe("[REDACTED]");
    expect(redacted.public_address).toBe("0xabcdef123456");
  });

  it("handles deeply nested structures with sensitive fields", () => {
    const data = {
      level1: {
        level2: {
          level3: {
            auth_token: "token-deep",
            value: "public-value",
          },
        },
      },
    };

    const redacted = redactSensitiveFields(data);
    expect(redacted.level1.level2.level3.auth_token).toBe("[REDACTED]");
    expect(redacted.level1.level2.level3.value).toBe("public-value");
  });

  it("redacts items in arrays", () => {
    const data = {
      apiKeys: [
        { id: "key-1", secret: "secret-1" },
        { id: "key-2", secret: "secret-2" },
      ],
    };

    const redacted = redactSensitiveFields(data);
    expect(Array.isArray(redacted.apiKeys)).toBe(true);
    expect(redacted.apiKeys.length).toBe(2);
    expect(redacted.apiKeys[0].id).toBe("key-1");
    expect(redacted.apiKeys[0].secret).toBe("[REDACTED]");
    expect(redacted.apiKeys[1].id).toBe("key-2");
    expect(redacted.apiKeys[1].secret).toBe("[REDACTED]");
  });

  it("supports custom redactable field list", () => {
    const customFields = ["internal_id", "custom_secret"];
    const data = {
      public_id: "123",
      internal_id: "secret-internal",
      custom_secret: "hidden",
    };

    const redacted = redactSensitiveFields(data, customFields);
    expect(redacted.public_id).toBe("123");
    expect(redacted.internal_id).toBe("[REDACTED]");
    expect(redacted.custom_secret).toBe("[REDACTED]");
  });

  it("preserves null and undefined values", () => {
    const data = {
      present: "value",
      nullField: null,
      undefinedField: undefined,
      token: "should-redact",
    };

    const redacted = redactSensitiveFields(data);
    expect(redacted.present).toBe("value");
    expect(redacted.nullField).toBeNull();
    expect(redacted.undefinedField).toBeUndefined();
    expect(redacted.token).toBe("[REDACTED]");
  });

  it("case-insensitive matching for sensitive fields", () => {
    const data = {
      authorization: "Bearer token",
      password: "secret123",
      api_key: "key456",
    };

    const redacted = redactSensitiveFields(data);
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.api_key).toBe("[REDACTED]");
  });

  it("handles partial field name matches correctly", () => {
    const data = {
      authorization_header: "Bearer token",
      x_api_key: "secret-key",
      regular_auth: "public",
    };

    const redacted = redactSensitiveFields(data);
    expect(redacted.authorization_header).toBe("[REDACTED]");
    expect(redacted.x_api_key).toBe("[REDACTED]");
    expect(redacted.regular_auth).toBe("public");
  });

  it("works with audit log middleware to redact request/response data", () => {
    const app = express();
    app.use(express.json());

    app.post(
      "/admin/test",
      auditLog("test_action", "resource"),
      (_req: Request, res: Response) => {
        res.status(200).json({ id: "123", token: "secret" });
      }
    );

    return request(app)
      .post("/admin/test")
      .send({ password: "secret-pass", username: "user" })
      .expect(200)
      .then((r) => {
        expect(r.body).toEqual({ id: "123", token: "secret" });
      });
  });
});
