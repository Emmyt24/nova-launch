-- CreateTable
CREATE TABLE "PaymentStreamMetadata" (
    "id" TEXT NOT NULL,
    "streamId" BIGINT NOT NULL,
    "creator" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentStreamMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentStreamMetadata_streamId_key" ON "PaymentStreamMetadata"("streamId");

-- CreateIndex
CREATE INDEX "PaymentStreamMetadata_creator_idx" ON "PaymentStreamMetadata"("creator");

-- CreateIndex
CREATE INDEX "PaymentStreamMetadata_recipient_idx" ON "PaymentStreamMetadata"("recipient");
