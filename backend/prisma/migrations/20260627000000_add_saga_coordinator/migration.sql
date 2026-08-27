-- CreateEnum
CREATE TYPE "SagaStatus" AS ENUM ('RUNNING', 'COMPLETED', 'COMPENSATING', 'COMPENSATED', 'FAILED');

-- CreateEnum
CREATE TYPE "SagaCompensationStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "SagaExecution" (
    "id" TEXT NOT NULL,
    "sagaType" TEXT NOT NULL,
    "status" "SagaStatus" NOT NULL DEFAULT 'RUNNING',
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "stepCount" INTEGER NOT NULL,
    "context" JSONB NOT NULL,
    "compensationStatus" "SagaCompensationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "compensatedStepIndex" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SagaExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenGovernanceRegistration" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenGovernanceRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SagaExecution_status_idx" ON "SagaExecution"("status");

-- CreateIndex
CREATE INDEX "SagaExecution_sagaType_idx" ON "SagaExecution"("sagaType");

-- CreateIndex
CREATE UNIQUE INDEX "TokenGovernanceRegistration_tokenId_key" ON "TokenGovernanceRegistration"("tokenId");

-- CreateIndex
CREATE INDEX "TokenGovernanceRegistration_tokenId_idx" ON "TokenGovernanceRegistration"("tokenId");

-- AddForeignKey
ALTER TABLE "TokenGovernanceRegistration" ADD CONSTRAINT "TokenGovernanceRegistration_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
