-- CreateEnum
CREATE TYPE "StreamWithdrawalType" AS ENUM ('CLAIMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "StreamWithdrawal" (
    "id" TEXT NOT NULL,
    "streamId" INTEGER NOT NULL,
    "transactionType" "StreamWithdrawalType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "recipient" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreamWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StreamWithdrawal_streamId_txHash_transactionType_key" ON "StreamWithdrawal"("streamId", "txHash", "transactionType");

-- CreateIndex
CREATE INDEX "StreamWithdrawal_streamId_timestamp_idx" ON "StreamWithdrawal"("streamId", "timestamp");
