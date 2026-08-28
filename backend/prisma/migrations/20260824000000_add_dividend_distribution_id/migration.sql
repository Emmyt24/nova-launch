-- Migration: correlate DividendPool with the on-chain distribution round (#1759)
-- Adds the on-chain distribution id plus ledger-based snapshot/deadline fields
-- so the DividendPool/HolderSnapshot/DividendClaim projection (added by
-- 20240226000000_add_dividend_distribution but never wired up) can be
-- populated from `initiate_distribution` / `claim_dividend` /
-- `reclaim_unclaimed` events emitted by the token-factory contract.

-- AlterTable DividendPool
ALTER TABLE "DividendPool"
  ADD COLUMN "distributionId" INTEGER,
  ADD COLUMN "asset" TEXT,
  ADD COLUMN "snapshotLedger" INTEGER,
  ADD COLUMN "claimDeadlineLedger" INTEGER;

-- Backfill is not required: DividendPool has no existing rows in any
-- environment (the model was added in 20240226000000_add_dividend_distribution
-- but no service code has ever written to it).

ALTER TABLE "DividendPool"
  ALTER COLUMN "distributionId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DividendPool_distributionId_key" ON "DividendPool"("distributionId");
