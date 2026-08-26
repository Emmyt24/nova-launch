-- AlterTable: Make adminId nullable in AdminAuditLog to support non-admin actor audit logging
ALTER TABLE "AdminAuditLog" ALTER COLUMN "adminId" DROP NOT NULL;

-- AlterForeignKey: Update foreign key constraint to allow NULL adminId
ALTER TABLE "AdminAuditLog" DROP CONSTRAINT "AdminAuditLog_adminId_fkey";

ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
