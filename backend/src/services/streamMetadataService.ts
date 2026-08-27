/**
 * Stream-metadata service for the payment-streaming/vesting feature (Issue #1765).
 *
 * Backs `routes/streams.ts`. This is a distinct feature from the pre-existing
 * Vaults ingestion pipeline (`streamProjectionService`, `streamEventParser`,
 * `streamReconciliation`, the `Stream`/`StreamStatus` Prisma model) — do not
 * confuse the two. `streamId` here refers to the token-factory contract's
 * `streaming` module stream id (a `u64`), stored as Prisma `BigInt`.
 *
 * `PaymentStreamMetadata` is supplementary, off-chain, descriptive data
 * (title/description/tags for search and display) — it is intentionally
 * separate from the on-chain `StreamInfo.metadata` field the contract itself
 * enforces immutability-after-first-claim on. Authorization here is a simple
 * creator-match check (no wallet-signature verification), consistent with
 * this backend's other read-mostly projection routes (e.g. `vaults.ts`);
 * the security-critical mutation is the on-chain `update_stream_metadata`
 * call, which the contract gates with `require_auth`.
 */

import { prisma } from "../lib/prisma";
import type { PaymentStreamMetadata } from "@prisma/client";

export type PaymentStreamMetadataDto = PaymentStreamMetadata;

export interface UpsertStreamMetadataInput {
  streamId: bigint;
  creator: string;
  recipient: string;
  title?: string | null;
  description?: string | null;
  tags?: string[];
}

export async function getStreamMetadata(
  streamId: bigint
): Promise<PaymentStreamMetadata | null> {
  return prisma.paymentStreamMetadata.findUnique({ where: { streamId } });
}

export async function listStreamMetadataByCreator(
  creator: string
): Promise<PaymentStreamMetadata[]> {
  return prisma.paymentStreamMetadata.findMany({
    where: { creator },
    orderBy: { createdAt: "desc" },
  });
}

export async function listStreamMetadataByRecipient(
  recipient: string
): Promise<PaymentStreamMetadata[]> {
  return prisma.paymentStreamMetadata.findMany({
    where: { recipient },
    orderBy: { createdAt: "desc" },
  });
}

export class StreamMetadataAuthError extends Error {
  constructor() {
    super("Only the stream's creator may update its metadata");
    this.name = "StreamMetadataAuthError";
  }
}

/**
 * Create or update a stream's off-chain metadata.
 *
 * On first write, `creator`/`recipient` are recorded. On subsequent writes,
 * `creator` must match the address recorded at creation — throws
 * `StreamMetadataAuthError` otherwise.
 */
export async function upsertStreamMetadata(
  input: UpsertStreamMetadataInput
): Promise<PaymentStreamMetadata> {
  const existing = await prisma.paymentStreamMetadata.findUnique({
    where: { streamId: input.streamId },
  });

  if (existing && existing.creator !== input.creator) {
    throw new StreamMetadataAuthError();
  }

  return prisma.paymentStreamMetadata.upsert({
    where: { streamId: input.streamId },
    create: {
      streamId: input.streamId,
      creator: input.creator,
      recipient: input.recipient,
      title: input.title ?? null,
      description: input.description ?? null,
      tags: input.tags ?? [],
    },
    update: {
      title: input.title ?? null,
      description: input.description ?? null,
      tags: input.tags ?? [],
    },
  });
}
