ALTER TABLE "Token" ADD COLUMN "deployTxHash" TEXT;

CREATE UNIQUE INDEX "Token_deployTxHash_key" ON "Token"("deployTxHash");

CREATE INDEX "Token_deployTxHash_idx" ON "Token"("deployTxHash");