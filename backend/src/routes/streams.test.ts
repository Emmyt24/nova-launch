/**
 * Security regression tests for streams metadata routes (Issue #1901).
 *
 * Validates that:
 * 1. PUT /api/streams/:streamId/metadata requires JWT authentication
 * 2. Unauthenticated requests are rejected with 401
 * 3. Requests with invalid/mismatched addresses are rejected with 401/403
 * 4. Only the authenticated creator can update stream metadata
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Express } from "express";
import jwt from "jsonwebtoken";
import streamsRouter from "./streams";

// Mock the streamMetadataService
vi.mock("../services/streamMetadataService", () => ({
  getStreamMetadata: vi.fn(),
  listStreamMetadataByCreator: vi.fn(),
  listStreamMetadataByRecipient: vi.fn(),
  upsertStreamMetadata: vi.fn(),
  StreamMetadataAuthError: class extends Error {
    constructor() {
      super("Only the stream's creator may update its metadata");
      this.name = "StreamMetadataAuthError";
    }
  },
}));

import {
  upsertStreamMetadata,
  StreamMetadataAuthError,
} from "../services/streamMetadataService";

// Setup test Express app
function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/streams", streamsRouter);
  return app;
}

function createJWT(tenantId: string, secret: string = "test-jwt-secret"): string {
  return jwt.sign(
    { tenantId, tenantName: "Test Tenant" },
    secret,
    { expiresIn: "1h" }
  );
}

describe("Streams routes - Security (#1901)", () => {
  let app: Express;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
    // Set test JWT secret for tenancy middleware
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  describe("PUT /:streamId/metadata - Authentication", () => {
    it("should reject unauthenticated requests with 401", async () => {
      const response = await request(app)
        .put("/streams/123/metadata")
        .send({ recipient: "GRECIPIENT", title: "Test" });

      expect(response.status).toBe(401);
      expect(response.body.error?.code).toBe("UNAUTHENTICATED");
    });

    it("should reject requests with invalid JWT with 401", async () => {
      const response = await request(app)
        .put("/streams/123/metadata")
        .set("Authorization", "Bearer invalid-token")
        .send({ recipient: "GRECIPIENT", title: "Test" });

      expect(response.status).toBe(401);
      expect(response.body.error?.code).toBe("UNAUTHENTICATED");
    });

    it("should accept valid JWT and pass authenticated caller to service", async () => {
      const creatorAddress = "GCREATOR1234567890ABCDEF";
      const jwtToken = createJWT(creatorAddress);

      (upsertStreamMetadata as any).mockResolvedValue({
        streamId: 123n,
        creator: creatorAddress,
        recipient: "GRECIPIENT",
        title: "Test",
      });

      const response = await request(app)
        .put("/streams/123/metadata")
        .set("Authorization", `Bearer ${jwtToken}`)
        .send({ recipient: "GRECIPIENT", title: "Test" });

      expect(response.status).toBe(200);
      expect(upsertStreamMetadata).toHaveBeenCalledWith({
        streamId: 123n,
        creator: creatorAddress, // Extracted from JWT
        recipient: "GRECIPIENT",
        title: "Test",
        description: undefined,
        tags: undefined,
      });
    });

    it("should reject unauthorized creator update attempts with 403", async () => {
      const attackerCreator = "GATTACKER234567890ABCDE";
      const jwtToken = createJWT(attackerCreator);

      (upsertStreamMetadata as any).mockRejectedValue(
        new StreamMetadataAuthError()
      );

      const response = await request(app)
        .put("/streams/123/metadata")
        .set("Authorization", `Bearer ${jwtToken}`)
        .send({ recipient: "GRECIPIENT", title: "Hacked" });

      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe("UNAUTHORIZED");
    });
  });

  describe("PUT /:streamId/metadata - Request Validation", () => {
    it("should validate recipient field is required", async () => {
      const jwtToken = createJWT("GCREATOR1234567890ABCDEF");

      const response = await request(app)
        .put("/streams/123/metadata")
        .set("Authorization", `Bearer ${jwtToken}`)
        .send({ title: "Test" }); // missing recipient

      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe("VALIDATION_ERROR");
    });

    it("should not accept creator field in request body", async () => {
      const authenticatedCreator = "GCREATOR1234567890ABCDEF";
      const jwtToken = createJWT(authenticatedCreator);

      (upsertStreamMetadata as any).mockResolvedValue({
        streamId: 123n,
        creator: authenticatedCreator,
        recipient: "GRECIPIENT",
      });

      const response = await request(app)
        .put("/streams/123/metadata")
        .set("Authorization", `Bearer ${jwtToken}`)
        .send({
          recipient: "GRECIPIENT",
          creator: "GMALICIOUS", // Attempt to override creator
        });

      // The request should succeed, but the creator should be ignored
      // (upsertStreamMetadata is called with the authenticated creator, not the body creator)
      expect(response.status).toBe(200);
      expect(upsertStreamMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          creator: authenticatedCreator, // From JWT, not from body
        })
      );
    });

    it("should validate title field length constraints", async () => {
      const jwtToken = createJWT("GCREATOR1234567890ABCDEF");

      const response = await request(app)
        .put("/streams/123/metadata")
        .set("Authorization", `Bearer ${jwtToken}`)
        .send({
          recipient: "GRECIPIENT",
          title: "x".repeat(201), // Exceeds max 200 chars
        });

      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe("VALIDATION_ERROR");
    });
  });
});
