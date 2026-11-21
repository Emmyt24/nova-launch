/**
 * Streams route for the payment-streaming/vesting feature (Issue #1765).
 *
 * Distinct from `routes/vaults.ts`, which backs the pre-existing Vaults
 * feature's ingestion pipeline (`streamProjectionService` etc.) — see that
 * file's naming-history note. This route only serves off-chain descriptive
 * metadata (`streamMetadataService`) for streams created via the
 * token-factory contract's `streaming` module; it does not ingest on-chain
 * events itself.
 *
 * Security: PUT /api/streams/:streamId/metadata requires JWT authentication
 * (#1901). The authenticated caller's address is extracted from the JWT
 * and used to authorize updates, replacing the insecure plaintext creator
 * comparison.
 */

import { Router, Request, Response } from "express";
import { successResponse, errorResponse } from "../utils/response";
import {
  getStreamMetadata,
  listStreamMetadataByCreator,
  listStreamMetadataByRecipient,
  upsertStreamMetadata,
  StreamMetadataAuthError,
  type PaymentStreamMetadataDto,
} from "../services/streamMetadataService";
import { tenantMiddleware, type TenantRequest } from "../middleware/tenancy";
import { validateStreamMetadata } from "../services/streamMetadataValidation";
import { logger } from "../lib/logger";

const router = Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStreamId(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

// `streamId` is a Prisma BigInt — JSON.stringify (used by res.json) throws on
// BigInt, so every response must serialize it to a string first.
function serialize(record: PaymentStreamMetadataDto): Record<string, unknown> {
  return { ...record, streamId: record.streamId.toString() };
}
function serializeAll(
  records: PaymentStreamMetadataDto[]
): Record<string, unknown>[] {
  return records.map(serialize);
}

/**
 * GET /api/streams/:streamId/metadata
 * Off-chain metadata for a single stream (null data if none has been set).
 */
router.get("/:streamId/metadata", async (req: Request, res: Response) => {
  const streamId = parseStreamId(req.params.streamId);
  if (streamId === null) {
    return res
      .status(400)
      .json(
        errorResponse({ code: "INVALID_INPUT", message: "Invalid stream ID" })
      );
  }

  try {
    const metadata = await getStreamMetadata(streamId);
    res.json(successResponse(metadata ? serialize(metadata) : null));
  } catch (error) {
    logger.error("Failed to fetch stream metadata", {
      route: "GET /api/streams/:streamId/metadata",
      streamId: streamId.toString(),
      error: errorMessage(error),
    });
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch stream metadata",
      })
    );
  }
});

/**
 * PUT /api/streams/:streamId/metadata
 *
 * Create or update a stream's off-chain metadata. Requires JWT authentication.
 * The authenticated caller's address becomes the creator on first write.
 * Subsequent writes must be made by the same authenticated caller or are
 * rejected with 401/403.
 *
 * Security (#1901): Caller identity is derived from JWT, not the request body.
 * This prevents unauthorized updates via plaintext address impersonation.
 *
 * Security (#2379): On an authorization failure the client receives a fixed
 * generic message ("Authentication required"); the underlying auth error is
 * logged server-side only, never echoed back to the caller.
 *
 * Validation (#2209): the body is checked and sanitized by
 * `validateStreamMetadata` (allowed fields, size and per-field limits).
 * Failures return 400 `VALIDATION_ERROR` (413 `PAYLOAD_TOO_LARGE` for an
 * oversized body) with a `details` array naming each offending field.
 */
router.put(
  "/:streamId/metadata",
  tenantMiddleware({ required: true }),
  async (req: TenantRequest, res: Response) => {
    const streamId = parseStreamId(req.params.streamId);
    if (streamId === null) {
      return res
        .status(400)
        .json(
          errorResponse({ code: "INVALID_INPUT", message: "Invalid stream ID" })
        );
    }

    // Extract authenticated caller's address from JWT via tenancy middleware
    if (!req.tenant) {
      return res.status(401).json(
        errorResponse({
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        })
      );
    }

    const validation = validateStreamMetadata(req.body);
    if (!validation.ok) {
      const tooLarge = validation.errors.some(
        (e) => e.code === "PAYLOAD_TOO_LARGE"
      );
      return res.status(tooLarge ? 413 : 400).json(
        errorResponse({
          code: tooLarge ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
          message: validation.errors.map((e) => e.message).join("; "),
          details: validation.errors,
        })
      );
    }

    try {
      const metadata = await upsertStreamMetadata({
        streamId,
        creator: req.tenant.id, // Use authenticated caller's address from JWT
        ...validation.value,
      });
      res.json(successResponse(serialize(metadata)));
    } catch (error) {
      if (error instanceof StreamMetadataAuthError) {
        // Do not echo the raw auth error to the client; log it server-side.
        logger.error("Stream metadata authorization failed", {
          route: "PUT /api/streams/:streamId/metadata",
          streamId: streamId.toString(),
          error: errorMessage(error),
        });
        return res.status(403).json(
          errorResponse({
            code: "UNAUTHORIZED",
            message: "Authentication required",
          })
        );
      }
      logger.error("Failed to update stream metadata", {
        route: "PUT /api/streams/:streamId/metadata",
        streamId: streamId.toString(),
        error: errorMessage(error),
      });
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update stream metadata",
        })
      );
    }
  }
);

/**
 * GET /api/streams/creator/:address
 * All streams (metadata) created by an address.
 */
router.get("/creator/:address", async (req: Request, res: Response) => {
  try {
    const streams = await listStreamMetadataByCreator(req.params.address);
    res.json(successResponse(serializeAll(streams)));
  } catch (error) {
    logger.error("Failed to fetch creator streams", {
      route: "GET /api/streams/creator/:address",
      address: req.params.address,
      error: errorMessage(error),
    });
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch creator streams",
      })
    );
  }
});

/**
 * GET /api/streams/recipient/:address
 * All streams (metadata) where an address is the recipient.
 */
router.get("/recipient/:address", async (req: Request, res: Response) => {
  try {
    const streams = await listStreamMetadataByRecipient(req.params.address);
    res.json(successResponse(serializeAll(streams)));
  } catch (error) {
    logger.error("Failed to fetch recipient streams", {
      route: "GET /api/streams/recipient/:address",
      address: req.params.address,
      error: errorMessage(error),
    });
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch recipient streams",
      })
    );
  }
});

export default router;
