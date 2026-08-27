-- CreateEnum
CREATE TYPE "ProjectionType" AS ENUM ('CAMPAIGN', 'GOVERNANCE', 'STREAM', 'VAULT');

-- CreateTable
CREATE TABLE "ProjectionSnapshot" (
    "id" TEXT NOT NULL,
    "projectionType" "ProjectionType" NOT NULL,
    "ledger" INTEGER NOT NULL,
    "cursor" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectionSnapshot_projectionType_ledger_key" ON "ProjectionSnapshot"("projectionType", "ledger");

-- CreateIndex
CREATE INDEX "ProjectionSnapshot_projectionType_ledger_idx" ON "ProjectionSnapshot"("projectionType", "ledger");
