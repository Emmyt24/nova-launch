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
import { z } from "zod";
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

const router = Router();

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

const upsertMetadataSchema = z.object({
  recipient: z.string().min(1),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

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
    console.error("[streams] GET /:streamId/metadata error:", error);
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

    const parsed = upsertMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(
        errorResponse({
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
          details: parsed.error.issues,
        })
      );
    }

    try {
      const metadata = await upsertStreamMetadata({
        streamId,
        creator: req.tenant.id, // Use authenticated caller's address from JWT
        ...parsed.data,
      });
      res.json(successResponse(serialize(metadata)));
    } catch (error) {
      if (error instanceof StreamMetadataAuthError) {
        return res
          .status(403)
          .json(errorResponse({ code: "UNAUTHORIZED", message: error.message }));
      }
      console.error("[streams] PUT /:streamId/metadata error:", error);
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
    console.error("[streams] GET /creator/:address error:", error);
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
    console.error("[streams] GET /recipient/:address error:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch recipient streams",
      })
    );
  }
});

export default router;
