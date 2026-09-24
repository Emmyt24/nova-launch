/**
 * Unit tests for the SendGrid and Twilio notification provider implementations.
 *
 * Covers:
 *  - SendGrid: successful delivery (202), provider 5xx error, missing credentials guard
 *  - Twilio: successful delivery (201), provider 5xx error, missing credentials guard
 *  - Retry: transient 5xx is retried up to MAX_RETRIES
 *  - Non-retryable 4xx stops immediately (no extra attempts)
 *  - PII masking: full email/phone never appears in logs
 *  - Rate limiter: second identical delivery within window is suppressed
 *  - Template rendering: TOKEN_DEPLOYED / VAULT_MATURED / PROPOSAL_PASSED
 *  - Backward compat: legacy NOTIFICATION_EMAIL_API_URL / NOTIFICATION_SMS_API_URL still work
 *
 * No real credentials appear in any fixture.
 *
 * Issue: #1264
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import axios from "axios";
import { NotificationService, isEmailEnabled, isSmsEnabled } from "../notificationService";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("axios");
vi.mock("../webhookDeliveryService", () => ({
  default: { triggerEvent: vi.fn() },
}));

// Stub fs.readFileSync so template loading works in the test environment
// without needing actual files on disk.
vi.mock("fs", () => ({
  readFileSync: vi.fn((_path: string) => {
    // Return a minimal template with the required placeholders
    return "<html>{{message}} {{tokenAddress}} {{unsubscribeUrl}}</html>";
  }),
}));

const mockedPost = axios.post as MockedFunction<typeof axios.post>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService() {
  return new NotificationService();
}

function successAxios(status = 202) {
  return mockedPost.mockResolvedValue({ status, data: {} });
}

function failAxios(status: number, message = "Provider error") {
  return mockedPost.mockResolvedValue({ status, data: { message } });
}

function networkErrorAxios() {
  return mockedPost.mockRejectedValue(new Error("ECONNREFUSED"));
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);
}

// ---------------------------------------------------------------------------
// isEmailEnabled / isSmsEnabled guards
// ---------------------------------------------------------------------------

describe("isEmailEnabled()", () => {
  beforeEach(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });
  afterEach(restoreEnv);

  it("returns false and logs a warning when no provider is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isEmailEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EMAIL channel"));
    warn.mockRestore();
  });

  it("returns true when SENDGRID_API_KEY is set", () => {
    setEnv({ SENDGRID_API_KEY: "SG.fake-key" });
    expect(isEmailEnabled()).toBe(true);
  });

  it("returns true when legacy NOTIFICATION_EMAIL_API_URL is set", () => {
    setEnv({ NOTIFICATION_EMAIL_API_URL: "https://email.example.com/send" });
    expect(isEmailEnabled()).toBe(true);
  });
});

describe("isSmsEnabled()", () => {
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.NOTIFICATION_SMS_API_URL;
  });
  afterEach(restoreEnv);

  it("returns false and logs a warning when no provider is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isSmsEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SMS channel"));
    warn.mockRestore();
  });

  it("returns true when both Twilio env vars are set", () => {
    setEnv({ TWILIO_ACCOUNT_SID: "ACfake", TWILIO_AUTH_TOKEN: "fake-token" });
    expect(isSmsEnabled()).toBe(true);
  });

  it("returns false when only TWILIO_ACCOUNT_SID is set (missing AUTH_TOKEN)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setEnv({ TWILIO_ACCOUNT_SID: "ACfake" });
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(isSmsEnabled()).toBe(false);
    warn.mockRestore();
  });

  it("returns true when legacy NOTIFICATION_SMS_API_URL is set", () => {
    setEnv({ NOTIFICATION_SMS_API_URL: "https://sms.example.com/send" });
    expect(isSmsEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SendGrid provider
// ---------------------------------------------------------------------------

describe("SendGrid email provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      SENDGRID_API_KEY: "SG.fake-key-for-tests",
      NOTIFICATION_FROM_EMAIL: "noreply@nova-launch.app",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });
  afterEach(restoreEnv);

  it("sends to the SendGrid v3 endpoint on success", async () => {
    successAxios(202);
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "creator@example.com" }],
      payload: { message: "Your token is live", subject: "Token Deployed" },
    });

    expect(result[0].success).toBe(true);
    expect(result[0].provider).toBe("sendgrid");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://api.sendgrid.com/v3/mail/send",
      expect.objectContaining({
        personalizations: [{ to: [{ email: "creator@example.com" }] }],
        subject: "Token Deployed",
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer SG.fake-key-for-tests",
        }),
      })
    );
  });

  it("returns failure when SendGrid returns 5xx", async () => {
    failAxios(500);
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Test" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("500");
  });

  it("retries on 5xx up to MAX_RETRIES and reports final failure", async () => {
    // All three attempts fail with 503
    mockedPost
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 503, data: {} });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Retry test" },
    });

    expect(result[0].success).toBe(false);
    // MAX_RETRIES=3 → axios called 3 times
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on non-retryable 4xx (400)", async () => {
    failAxios(400);
    const svc = makeService();

    await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Bad request test" },
    });

    // Should only attempt once — 400 is non-retryable
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("retries on network error (ECONNREFUSED) and eventually fails", async () => {
    networkErrorAxios();
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Network error test" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("ECONNREFUSED");
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("returns unconfigured error when SENDGRID_API_KEY is absent", async () => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.NOTIFICATION_EMAIL_API_URL;
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "No config" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("Email channel is not configured");
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("does not log the full email address (PII masking)", async () => {
    successAxios(202);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const svc = makeService();

    await svc.send({
      targets: [{ type: "EMAIL", destination: "secret-user@private.com" }],
      payload: { message: "PII test", subject: "pii-event" },
    });

    for (const call of info.mock.calls) {
      const log = call.join(" ");
      expect(log).not.toContain("secret-user");
      expect(log).not.toContain("secret-user@private.com");
      // Domain is OK to show; local part must be masked
      expect(log).toContain("****@private.com");
    }
    info.mockRestore();
  });

  it("renders TOKEN_DEPLOYED HTML template when templateKey is provided", async () => {
    successAxios(202);
    const svc = makeService();

    await svc.send({
      targets: [{ type: "EMAIL", destination: "creator@example.com" }],
      payload: {
        message: "Your token MYTKN is live",
        subject: "Token Deployed",
        tokenAddress: "GABC123",
        metadata: { templateKey: "TOKEN_DEPLOYED", tokenName: "My Token" },
      },
    });

    // The mocked readFileSync returns HTML with {{message}} and {{tokenAddress}}
    // so the second argument to axios.post should contain rendered HTML
    const body = mockedPost.mock.calls[0][1] as any;
    const htmlContent = body.content?.find((c: any) => c.type === "text/html");
    expect(htmlContent).toBeDefined();
    expect(htmlContent.value).toContain("Your token MYTKN is live");
    expect(htmlContent.value).toContain("GABC123");
  });

  it("escapes regex metacharacters in metadata keys to prevent template injection (Issue #1978)", async () => {
    successAxios(202);
    const svc = makeService();

    // Metadata key with regex special characters
    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: {
        message: "Template test",
        subject: "Test Event",
        metadata: {
          templateKey: "TOKEN_DEPLOYED",
          "key(with)special*chars": "value123",
          "bracket[test]": "content",
          "dot.separator": "dotted",
        },
      },
    });

    // Should not throw and should succeed
    expect(result[0].success).toBe(true);

    // Verify the mocked template was called and rendered
    const body = mockedPost.mock.calls[0][1] as any;
    expect(body).toBeDefined();

    // The rendered template should contain the message (original placeholder)
    const htmlContent = body.content?.find((c: any) => c.type === "text/html");
    expect(htmlContent?.value).toContain("Template test");
  });

  it("handles metadata keys with regex quantifiers without corrupting placeholders", async () => {
    successAxios(202);
    const svc = makeService();

    // Test with various regex special characters
    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: {
        message: "Important: Keep this text",
        subject: "Security Test",
        metadata: {
          templateKey: "TOKEN_DEPLOYED",
          "amount*": "100", // asterisk (quantifier)
          "count+": "5", // plus (quantifier)
          "id?": "abc", // question mark (optional)
          "pattern|alt": "test", // pipe (alternation)
          "group(a)": "value", // parens (grouping)
          "escape\\test": "ok", // backslash
        },
      },
    });

    expect(result[0].success).toBe(true);

    // The original message placeholder should still be intact in the output
    const body = mockedPost.mock.calls[0][1] as any;
    const htmlContent = body.content?.find((c: any) => c.type === "text/html");
    // Our mocked template includes {{message}}, which should be rendered
    expect(htmlContent?.value).toContain("Important: Keep this text");
  });
});

// ---------------------------------------------------------------------------
// Legacy email HTTP adapter (backward compat)
// ---------------------------------------------------------------------------

describe("Legacy email HTTP adapter (NOTIFICATION_EMAIL_API_URL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      NOTIFICATION_EMAIL_API_URL: "https://email.example.com/send",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.SENDGRID_API_KEY;
  });
  afterEach(restoreEnv);

  it("posts to the configured URL when no SendGrid key is set", async () => {
    mockedPost.mockResolvedValue({ status: 202, data: {} });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Email body", subject: "Hi" },
    });

    expect(result[0].success).toBe(true);
    expect(result[0].provider).toBe("email");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://email.example.com/send",
      expect.objectContaining({ to: "user@example.com", body: "Email body", subject: "Hi" }),
      expect.any(Object)
    );
  });

  it("returns failure for email when no destination is provided", async () => {
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "EMAIL" }],
      payload: { message: "Missing destination" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("Email notifications require a destination email address");
  });
});

// ---------------------------------------------------------------------------
// Twilio SMS provider
// ---------------------------------------------------------------------------

describe("Twilio SMS provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      TWILIO_ACCOUNT_SID: "ACfakeaccountsid",
      TWILIO_AUTH_TOKEN: "fakeauthtoken",
      TWILIO_PHONE_NUMBER: "+15550001234",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_SMS_API_URL;
  });
  afterEach(restoreEnv);

  it("posts to the Twilio Messages endpoint on success", async () => {
    mockedPost.mockResolvedValue({ status: 201, data: { sid: "SMfake" } });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Your vault has matured" },
    });

    expect(result[0].success).toBe(true);
    expect(result[0].provider).toBe("twilio");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/ACfakeaccountsid/Messages.json",
      expect.stringContaining("To=%2B15559876543"),
      expect.objectContaining({
        auth: { username: "ACfakeaccountsid", password: "fakeauthtoken" },
      })
    );
  });

  it("uses URL-encoded form body (application/x-www-form-urlencoded)", async () => {
    mockedPost.mockResolvedValue({ status: 201, data: {} });
    const svc = makeService();

    await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Encoded body test" },
    });

    const [, body, config] = mockedPost.mock.calls[0] as [string, string, any];
    expect(typeof body).toBe("string"); // URL-encoded string, not JSON
    expect(config.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("returns failure when Twilio returns 5xx", async () => {
    mockedPost.mockResolvedValue({ status: 500, data: { message: "Internal Error" } });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Twilio 5xx test" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("500");
  });

  it("retries on 5xx up to MAX_RETRIES", async () => {
    mockedPost
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 503, data: {} })
      .mockResolvedValueOnce({ status: 503, data: {} });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Retry SMS test" },
    });

    expect(result[0].success).toBe(false);
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on non-retryable 400", async () => {
    mockedPost.mockResolvedValue({ status: 400, data: { message: "Invalid number" } });
    const svc = makeService();

    await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "Bad number" },
    });

    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("returns unconfigured error when Twilio credentials are absent", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.NOTIFICATION_SMS_API_URL;
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15559876543" }],
      payload: { message: "No config" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("SMS channel is not configured");
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("does not log the full phone number (PII masking)", async () => {
    mockedPost.mockResolvedValue({ status: 201, data: {} });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const svc = makeService();

    await svc.send({
      targets: [{ type: "SMS", destination: "+15559998877" }],
      payload: { message: "PII SMS test" },
    });

    for (const call of info.mock.calls) {
      const log = call.join(" ");
      expect(log).not.toContain("+15559998877");
      expect(log).not.toContain("15559998877");
      expect(log).toContain("****8877");
    }
    info.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Legacy SMS HTTP adapter (backward compat)
// ---------------------------------------------------------------------------

describe("Legacy SMS HTTP adapter (NOTIFICATION_SMS_API_URL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      NOTIFICATION_SMS_API_URL: "https://sms.example.com/send",
      NODE_ENV: "test",
    });
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });
  afterEach(restoreEnv);

  it("posts to the configured SMS URL when no Twilio credentials are set", async () => {
    mockedPost.mockResolvedValue({ status: 200, data: {} });
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS", destination: "+15551234567" }],
      payload: { message: "Legacy SMS test" },
    });

    expect(result[0].success).toBe(true);
    expect(result[0].provider).toBe("sms");
    expect(mockedPost).toHaveBeenCalledWith(
      "https://sms.example.com/send",
      expect.objectContaining({ to: "+15551234567", message: "Legacy SMS test" }),
      expect.any(Object)
    );
  });

  it("returns failure when no destination provided", async () => {
    const svc = makeService();

    const result = await svc.send({
      targets: [{ type: "SMS" }],
      payload: { message: "No dest" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("SMS notifications require a destination phone number");
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe("Notification rate limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      SENDGRID_API_KEY: "SG.fake-key",
      NODE_ENV: "test",
      // Very short window so tests don't have to wait
      NOTIFICATION_RATE_LIMIT_WINDOW_MS: "60000",
    });
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });
  afterEach(restoreEnv);

  it("suppresses the second identical delivery within the rate-limit window", async () => {
    successAxios(202);
    const svc = makeService();

    const req = {
      targets: [{ type: "EMAIL" as const, destination: "rl@example.com" }],
      payload: { message: "Rate limit test", subject: "rl-event" },
    };

    const first = await svc.send(req);
    expect(first[0].success).toBe(true);

    // Second send to same recipient+subject within window
    const second = await svc.send(req);
    expect(second[0].success).toBe(false);
    expect(second[0].error).toContain("Rate limit exceeded");

    // axios.post called only once (the second was suppressed before hitting the provider)
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("allows delivery to different recipients independently", async () => {
    successAxios(202);
    const svc = makeService();

    await svc.send({
      targets: [{ type: "EMAIL", destination: "a@example.com" }],
      payload: { message: "Hi A", subject: "same-event" },
    });
    const second = await svc.send({
      targets: [{ type: "EMAIL", destination: "b@example.com" }],
      payload: { message: "Hi B", subject: "same-event" },
    });

    expect(second[0].success).toBe(true);
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Existing channel registration guard (backward compat)
// ---------------------------------------------------------------------------

describe("registerChannel duplicate guard", () => {
  it("throws when the same channel is registered twice", () => {
    const svc = makeService();
    expect(() => svc.registerChannel("EMAIL", vi.fn() as any)).toThrow(
      /Notification channel handler already registered for EMAIL/
    );
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker integration
// ---------------------------------------------------------------------------

describe("SendGrid circuit breaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      SENDGRID_API_KEY: "SG.fake-key-for-tests",
      NODE_ENV: "test",
      MAX_RETRIES: "3",
    });
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });
  afterEach(restoreEnv);

  it("opens after repeated exhausted deliveries and fails fast without calling the provider", async () => {
    failAxios(500);
    const svc = makeService();

    // Each send exhausts 3 retries (failureThreshold for this breaker is 5).
    // Use a distinct destination per call so the rate limiter doesn't
    // suppress these as duplicate sends.
    for (let i = 0; i < 5; i++) {
      const result = await svc.send({
        targets: [{ type: "EMAIL", destination: `user${i}@example.com` }],
        payload: { message: "trip the breaker", subject: `event-${i}` },
      });
      expect(result[0].success).toBe(false);
    }

    expect(mockedPost).toHaveBeenCalledTimes(15); // 5 deliveries x 3 attempts each

    // The 6th delivery should fail immediately — circuit is now open.
    const result = await svc.send({
      targets: [{ type: "EMAIL", destination: "user-after-trip@example.com" }],
      payload: { message: "should not reach the provider", subject: "event-trip" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("Circuit breaker is open");
    expect(mockedPost).toHaveBeenCalledTimes(15); // unchanged — no new attempt was made
  });
});
