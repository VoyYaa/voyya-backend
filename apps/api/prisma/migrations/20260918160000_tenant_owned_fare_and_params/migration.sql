-- ADR-018: trips.fare_config and admin.system_parameter become company-owned resources.
-- Sequence: add nullable company_id -> backfill from the active company of each row's
-- municipality -> count and log orphan rows -> delete orphans (see note below, approved
-- and required by the rollout runbook) -> close duplicate open fare versions -> enforce
-- NOT NULL + FK -> drop the old municipality_id wiring -> new indexes -> audit columns.

ALTER TABLE "trips"."fare_config" ADD COLUMN "company_id" INTEGER;
ALTER TABLE "admin"."system_parameter" ADD COLUMN "company_id" INTEGER;

UPDATE "trips"."fare_config" f
   SET "company_id" = sub.company_id
  FROM (
    SELECT DISTINCT ON (c."municipality_id") c."municipality_id", c."company_id"
      FROM "tenancy"."company" c
     WHERE c."status" = 'active'
     ORDER BY c."municipality_id", c."company_id" ASC
  ) sub
 WHERE f."municipality_id" = sub."municipality_id";

UPDATE "admin"."system_parameter" p
   SET "company_id" = sub.company_id
  FROM (
    SELECT DISTINCT ON (c."municipality_id") c."municipality_id", c."company_id"
      FROM "tenancy"."company" c
     WHERE c."status" = 'active'
     ORDER BY c."municipality_id", c."company_id" ASC
  ) sub
 WHERE p."municipality_id" = sub."municipality_id";

-- Deviation from ADR-018 §9.3, authorized: count and log the orphan rows before the
-- destructive DELETE below, instead of deleting silently. A number in the deploy log
-- costs nothing; a silent production delete cannot be undone.
DO $$
DECLARE
  orphan_fare_config_count integer;
  orphan_system_parameter_count integer;
BEGIN
  SELECT count(*) INTO orphan_fare_config_count
    FROM "trips"."fare_config" WHERE "company_id" IS NULL;
  SELECT count(*) INTO orphan_system_parameter_count
    FROM "admin"."system_parameter" WHERE "company_id" IS NULL;

  RAISE NOTICE 'ADR-018 backfill: about to delete % orphan trips.fare_config row(s) and % orphan admin.system_parameter row(s) (no active company resolved for their municipality_id)',
    orphan_fare_config_count, orphan_system_parameter_count;
END $$;

-- Deliberate cleanup: rows that did not resolve to any active company (orphan
-- municipality, or a generic municipality_id that never matched one). See §10/§11 of
-- the delivery report: confirmed by the user for this ADR before it runs against Railway.
DELETE FROM "trips"."fare_config" WHERE "company_id" IS NULL;
DELETE FROM "admin"."system_parameter" WHERE "company_id" IS NULL;

-- Closes duplicate open versions in case ADR-002/B-13 already left two open rows before
-- the unique index below existed (same pattern ADR-017 §8.4 foresaw).
UPDATE "trips"."fare_config" f
   SET "valid_to" = CURRENT_DATE
 WHERE f."valid_to" IS NULL
   AND EXISTS (
     SELECT 1 FROM "trips"."fare_config" g
      WHERE g."company_id" = f."company_id"
        AND g."service_type" = f."service_type"
        AND g."valid_to" IS NULL
        AND g."fare_config_id" > f."fare_config_id"
   );

ALTER TABLE "trips"."fare_config" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "trips"."fare_config"
  ADD CONSTRAINT "fare_config_company_id_fkey" FOREIGN KEY ("company_id")
  REFERENCES "tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin"."system_parameter" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "admin"."system_parameter"
  ADD CONSTRAINT "system_parameter_company_id_fkey" FOREIGN KEY ("company_id")
  REFERENCES "tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trips"."fare_config" DROP CONSTRAINT IF EXISTS "fare_config_municipality_id_fkey";
DROP INDEX IF EXISTS "trips"."fare_config_municipality_id_service_type_idx";
DROP INDEX IF EXISTS "trips"."fare_config_municipality_service_valid_from_idx";
ALTER TABLE "trips"."fare_config" DROP COLUMN "municipality_id";

ALTER TABLE "admin"."system_parameter" DROP CONSTRAINT IF EXISTS "system_parameter_municipality_id_fkey";
DROP INDEX IF EXISTS "admin"."system_parameter_key_municipality_id_key";
ALTER TABLE "admin"."system_parameter" DROP COLUMN "municipality_id";

CREATE INDEX "fare_config_company_id_service_type_idx"
  ON "trips"."fare_config" ("company_id", "service_type");
CREATE INDEX "fare_config_company_id_service_type_valid_from_idx"
  ON "trips"."fare_config" ("company_id", "service_type", "valid_from");
CREATE UNIQUE INDEX "system_parameter_key_company_id_key"
  ON "admin"."system_parameter" ("key", "company_id");

ALTER TABLE "trips"."fare_config"
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "created_by" INTEGER;
ALTER TABLE "trips"."fare_config"
  ADD CONSTRAINT "fare_config_created_by_fkey" FOREIGN KEY ("created_by")
  REFERENCES "auth"."user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
