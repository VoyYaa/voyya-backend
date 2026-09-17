-- AlterTable
ALTER TABLE "auth"."user" ADD COLUMN     "failed_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "blocked_until" TIMESTAMP(3);
