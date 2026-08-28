/**
 * Refresh token family service (#1345).
 *
 * Implements the token-family reuse-detection pattern:
 *  - Each login creates a new family (familyId = uuid).
 *  - On refresh: mark current token as used, issue new token in the same family.
 *  - On reuse (used token presented): invalidate ALL tokens in the family → 401.
 *
 * All rotation operations are atomic via a Prisma transaction.
 * pruneExpiredFamilies() is called by a cleanup job to remove families older than 30 days.
 */

import { v4 as uuidv4 } from "uuid";
import prisma from "../lib/prisma";

const FAMILY_TTL_DAYS = 30;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the initial family entry on new session (login).
 */
export async function createTokenFamily(
  token: string,
  expiresAt: Date
): Promise<{ familyId: string }> {
  const familyId = uuidv4();
  await (prisma as any).refreshToken.create({
    data: { familyId, token, expiresAt },
  });
  return { familyId };
}

/**
 * Rotate a refresh token within its family.
 *
 * Uses a conditional update to atomically check that the token exists and is
 * not yet used, preventing concurrent rotations from both succeeding.
 *
 * Throws TokenFamilyError with:
 *  - REUSE_DETECTED — if the presented token was already used (entire family invalidated)
 *  - INVALID_TOKEN  — if the token is not found in the store or is already used
 */
export async function rotateTokenFamily(
  currentToken: string,
  nextToken: string,
  nextExpiresAt: Date
): Promise<{ familyId: string }> {
  return (prisma as any).$transaction(async (tx: any) => {
    // Atomically mark token as used only if it exists and is not yet used.
    // This prevents two concurrent requests from both succeeding.
    const updateResult = await tx.refreshToken.updateMany({
      where: { token: currentToken, used: false },
      data: { used: true },
    });

    // If updateMany affected 0 rows, either the token doesn't exist or it's already used.
    // Re-fetch to determine which case applies so we can throw the appropriate error.
    if (updateResult.count === 0) {
      const record = await tx.refreshToken.findUnique({
        where: { token: currentToken },
      });

      if (!record) {
        throw new TokenFamilyError("INVALID_TOKEN", "Refresh token not found");
      }

      if (record.used) {
        // Reuse detected — invalidate the whole family to contain the breach
        await tx.refreshToken.deleteMany({
          where: { familyId: record.familyId },
        });
        throw new TokenFamilyError(
          "REUSE_DETECTED",
          "Refresh token reuse detected — entire family invalidated"
        );
      }
    }

    // If we reach here, updateResult.count === 1, meaning we successfully marked
    // the token as used. Fetch the record to get its familyId.
    const record = await tx.refreshToken.findUnique({
      where: { token: currentToken },
    });

    if (!record) {
      throw new TokenFamilyError(
        "INVALID_TOKEN",
        "Refresh token not found after update"
      );
    }

    // Issue new token in the same family
    await tx.refreshToken.create({
      data: {
        familyId: record.familyId,
        token: nextToken,
        expiresAt: nextExpiresAt,
      },
    });

    return { familyId: record.familyId };
  });
}

/**
 * Invalidate all tokens in a family (e.g., on explicit logout).
 */
export async function invalidateFamily(familyId: string): Promise<void> {
  await (prisma as any).refreshToken.deleteMany({ where: { familyId } });
}

/**
 * Prune expired token families older than FAMILY_TTL_DAYS.
 * Intended to be called by a periodic cleanup job.
 */
export async function pruneExpiredFamilies(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - FAMILY_TTL_DAYS * 24 * 60 * 60 * 1000);
  const result = await (prisma as any).refreshToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return { deleted: result.count };
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type TokenFamilyErrorCode = "INVALID_TOKEN" | "REUSE_DETECTED";

export class TokenFamilyError extends Error {
  constructor(
    public readonly code: TokenFamilyErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TokenFamilyError";
  }
}
