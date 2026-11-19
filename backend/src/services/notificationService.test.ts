import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { NotificationService } from "./notificationService";
import { NotificationChannelType } from "../types/notification";
import webhookDeliveryService from "./webhookDeliveryService";
import axios from "axios";
import { getNotificationPreferences } from "./notificationPreferences";

vi.mock("./notificationPreferences", () => ({
  getNotificationPreferences: vi.fn(async () => ({
    emailEnabled: true,
    smsEnabled: true,
    webhookEnabled: true,
  })),
  isNotificationChannelEnabled: vi.fn((preferences: any, channel: string) =>
    channel === "EMAIL" ? preferences.emailEnabled :
    channel === "SMS" ? preferences.smsEnabled : preferences.webhookEnabled
  ),
}));

vi.mock("axios");
vi.mock("./webhookDeliveryService", () => ({
  default: {
    triggerEvent: vi.fn(),
  },
}));

describe("NotificationService", () => {
  let service: NotificationService;

  beforeEach(() => {
    service = new NotificationService();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.SENDGRID_API_KEY;
    delete process.env.NOTIFICATION_EMAIL_API_URL;
  });

  it("throws when request has no targets", async () => {
    await expect(
      service.send({ targets: [], payload: { message: "Hello" } })
    ).rejects.toThrow("Notification request requires at least one target");
  });

  it("throws when payload.message is missing", async () => {
    await expect(
      service.send({
        targets: [{ type: "EMAIL", destination: "user@example.com" }],
        payload: { subject: "Test" } as any,
      })
    ).rejects.toThrow("Notification payload.message is required");
  });

  it("returns unsupported channel result for unregistered channel", async () => {
    const result = await service.send({
      targets: [{ type: "PUSH" as any, destination: "unused", provider: "unknown" }],
      payload: { message: "Hello" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("Unsupported notification channel");
  });

  it("sends webhook notifications when payload.event is provided", async () => {
    const payload = {
      message: "Webhook payload",
      event: "token.created" as any,
      tokenAddress: "G123",
    };

    const result = await service.send({
      targets: [{ type: "WEBHOOK" }],
      payload,
      correlationId: "cid-123",
    });

    expect(result[0].success).toBe(true);
    expect(webhookDeliveryService.triggerEvent).toHaveBeenCalledWith(
      payload.event,
      payload,
      "G123",
      "cid-123"
    );
  });

  it("returns failure when webhook payload.event is missing", async () => {
    const result = await service.send({
      targets: [{ type: "WEBHOOK" }],
      payload: { message: "Missing event" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("Webhook notifications require payload.event");
  });

  it("sends email when configured and returns success", async () => {
    process.env.NOTIFICATION_EMAIL_API_URL = "https://email.example.com/send";
    (axios.post as any).mockResolvedValue({ status: 202 });

    const result = await service.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Email body", subject: "Hi" },
    });

    expect(result[0].success).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      "https://email.example.com/send",
      expect.objectContaining({
        to: "user@example.com",
        body: "Email body",
        subject: "Hi",
      }),
      expect.any(Object)
    );
  });

  it("suppresses a channel disabled by the user's saved preference", async () => {
    vi.mocked(getNotificationPreferences).mockResolvedValueOnce({
      emailEnabled: false,
      smsEnabled: true,
      webhookEnabled: true,
    });

    process.env.NOTIFICATION_EMAIL_API_URL = "https://email.example.com/send";
    const result = await service.send({
      userId: "user-1",
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Preference check" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("Notification channel disabled by user preference");
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("returns failure for email when no destination is provided", async () => {
    process.env.NOTIFICATION_EMAIL_API_URL = "https://email.example.com/send";

    const result = await service.send({
      targets: [{ type: "EMAIL" }],
      payload: { message: "Missing destination" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("Email notifications require a destination email address");
  });

  it("returns failure for email when neither SENDGRID_API_KEY nor NOTIFICATION_EMAIL_API_URL is set", async () => {
    const result = await service.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Email body" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toMatch(/not configured/i);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("uses the generic HTTP branch when only NOTIFICATION_EMAIL_API_URL is set", async () => {
    process.env.NOTIFICATION_EMAIL_API_URL = "https://email.example.com/send";
    (axios.post as any).mockResolvedValue({ status: 202 });

    const result = await service.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Email body" },
    });

    expect(result[0].success).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      "https://email.example.com/send",
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("uses the SendGrid branch when only SENDGRID_API_KEY is set", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    (axios.post as any).mockResolvedValue({ status: 202 });

    const result = await service.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Email body" },
    });

    expect(result[0].success).toBe(true);
    expect(axios.post).toHaveBeenCalled();
  });

  it("does not leak secret values in the missing-configuration error", async () => {
    const result = await service.send({
      targets: [{ type: "EMAIL", destination: "user@example.com" }],
      payload: { message: "Email body" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBeDefined();
    expect(result[0].error).not.toContain("SG.");
    expect(result[0].error).not.toContain("SENDGRID_API_KEY=");
  });

  it("returns failure for sms when SMS channel is not configured", async () => {
    delete process.env.NOTIFICATION_SMS_API_URL;

    const result = await service.send({
      targets: [{ type: "SMS", destination: "+15551234567" }],
      payload: { message: "Test SMS" },
    });

    expect(result[0].success).toBe(false);
    expect(result[0].error).toBe("SMS channel is not configured");
  });

  it("throws when registering the same channel twice", () => {
    expect(() => service.registerChannel("EMAIL", vi.fn() as any)).toThrow(
      /Notification channel handler already registered for EMAIL/
    );
  });
});
