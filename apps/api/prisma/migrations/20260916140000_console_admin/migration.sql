-- AlterTable
ALTER TABLE "auth"."user" ADD COLUMN     "company_id" INTEGER;

-- CreateIndex
CREATE INDEX "user_company_id_role_idx" ON "auth"."user"("company_id", "role");

-- AddForeignKey
ALTER TABLE "auth"."user" ADD CONSTRAINT "user_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: link existing admin/operator staff to the pilot company (ADR-012).
-- Without this, TenantGuard rejects every admin/operator session with OUT_OF_TENANT.
UPDATE "auth"."user" u
   SET "company_id" = (SELECT MIN(c."company_id") FROM "tenancy"."company" c)
 WHERE u."role" IN ('admin', 'operator') AND u."company_id" IS NULL;

-- AlterTable
ALTER TABLE "fleet"."driver" ADD COLUMN     "pin_delivered_at" TIMESTAMP(3),
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: existing drivers already have a PIN in their hands (ADR-013).
-- Without this, driverLogin rejects every existing driver with PIN_NOT_DELIVERED.
UPDATE "fleet"."driver" SET "pin_delivered_at" = now() WHERE "pin_delivered_at" IS NULL;

-- Backfill: make valid_from deterministic before it becomes NOT NULL (ADR-014).
-- Without this, the ALTER COLUMN SET NOT NULL below fails on the seeded row.
UPDATE "trips"."fare_config" SET "valid_from" = CURRENT_DATE WHERE "valid_from" IS NULL;

-- AlterTable
ALTER TABLE "trips"."fare_config" ALTER COLUMN "valid_from" SET NOT NULL,
ALTER COLUMN "valid_from" SET DEFAULT CURRENT_DATE;

-- CreateIndex
CREATE INDEX "fare_config_municipality_service_valid_from_idx" ON "trips"."fare_config"("municipality_id", "service_type", "valid_from");

-- AlterTable
ALTER TABLE "admin"."system_parameter" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_by" INTEGER;

-- AddForeignKey
ALTER TABLE "admin"."system_parameter" ADD CONSTRAINT "system_parameter_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
