-- Migration: add admin management fields (#1694)
-- Adds role/banned to User, flagged/deleted/metadata to Token, and AdminAuditLog table.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin', 'super_admin');

-- AlterTable User
ALTER TABLE "User"
  ADD COLUMN "role"   "UserRole" NOT NULL DEFAULT 'user',
  ADD COLUMN "banned" BOOLEAN    NOT NULL DEFAULT false;

-- AlterTable Token
ALTER TABLE "Token"
  ADD COLUMN "flagged"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deleted"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "metadata" JSONB   DEFAULT '{}';

-- CreateTable AdminAuditLog
CREATE TABLE "AdminAuditLog" (
  "id"          TEXT          NOT NULL,
  "adminId"     TEXT          NOT NULL,
  "action"      TEXT          NOT NULL,
  "resource"    TEXT          NOT NULL,
  "resourceId"  TEXT          NOT NULL,
  "beforeState" JSONB,
  "afterState"  JSONB,
  "ipAddress"   TEXT          NOT NULL,
  "userAgent"   TEXT          NOT NULL,
  "timestamp"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_role_idx"              ON "User"("role");
CREATE INDEX "User_banned_idx"            ON "User"("banned");
CREATE INDEX "AdminAuditLog_adminId_idx"  ON "AdminAuditLog"("adminId");
CREATE INDEX "AdminAuditLog_action_idx"   ON "AdminAuditLog"("action");
CREATE INDEX "AdminAuditLog_resource_idx" ON "AdminAuditLog"("resource");
CREATE INDEX "AdminAuditLog_timestamp_idx" ON "AdminAuditLog"("timestamp");

-- AddForeignKey
ALTER TABLE "AdminAuditLog"
  ADD CONSTRAINT "AdminAuditLog_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
