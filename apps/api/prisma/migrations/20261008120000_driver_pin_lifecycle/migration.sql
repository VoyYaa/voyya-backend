ALTER TABLE "fleet"."driver" ADD COLUMN "pin_must_change" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "fleet"."driver" ADD COLUMN "temporary_pin_expires_at" TIMESTAMP(3);
ALTER TABLE "fleet"."driver" ADD COLUMN "pin_changed_at" TIMESTAMP(3);
ALTER TABLE "fleet"."driver" ADD CONSTRAINT "driver_temporary_pin_requires_change"
  CHECK ("temporary_pin_expires_at" IS NULL OR "pin_must_change");
