-- CreateTable
CREATE TABLE "TenantComplexityBudget" (
    "tenantId" TEXT NOT NULL,
    "complexityBudget" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantComplexityBudget_pkey" PRIMARY KEY ("tenantId")
);
