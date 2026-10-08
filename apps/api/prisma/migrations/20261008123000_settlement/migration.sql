CREATE TYPE "admin"."RemittanceEntryKind" AS ENUM ('remittance', 'reversal');

CREATE TABLE "admin"."settlement_remittance" (
    "remittance_id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "driver_id" INTEGER NOT NULL,
    "week_start" DATE NOT NULL,
    "kind" "admin"."RemittanceEntryKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reverses_remittance_id" INTEGER,
    "recorded_by" INTEGER NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),

    CONSTRAINT "settlement_remittance_pkey" PRIMARY KEY ("remittance_id")
);

CREATE TABLE "admin"."settlement_export" (
    "export_id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "exported_by" INTEGER NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "driver_id" INTEGER,
    "row_count" INTEGER NOT NULL,
    "exported_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),

    CONSTRAINT "settlement_export_pkey" PRIMARY KEY ("export_id")
);

CREATE UNIQUE INDEX "settlement_remittance_reverses_remittance_id_key" ON "admin"."settlement_remittance"("reverses_remittance_id");
CREATE INDEX "settlement_remittance_company_id_driver_id_week_start_idx" ON "admin"."settlement_remittance"("company_id", "driver_id", "week_start");
CREATE INDEX "settlement_export_company_id_exported_at_idx" ON "admin"."settlement_export"("company_id", "exported_at");

ALTER TABLE "admin"."settlement_remittance" ADD CONSTRAINT "settlement_remittance_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin"."settlement_remittance" ADD CONSTRAINT "settlement_remittance_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "fleet"."driver"("driver_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin"."settlement_remittance" ADD CONSTRAINT "settlement_remittance_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "auth"."user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin"."settlement_remittance" ADD CONSTRAINT "settlement_remittance_reverses_remittance_id_fkey" FOREIGN KEY ("reverses_remittance_id") REFERENCES "admin"."settlement_remittance"("remittance_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin"."settlement_export" ADD CONSTRAINT "settlement_export_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin"."settlement_export" ADD CONSTRAINT "settlement_export_exported_by_fkey" FOREIGN KEY ("exported_by") REFERENCES "auth"."user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin"."settlement_remittance"
  ADD CONSTRAINT "settlement_remittance_week_starts_monday" CHECK (EXTRACT(ISODOW FROM "week_start") = 1),
  ADD CONSTRAINT "settlement_remittance_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "settlement_remittance_reversal_shape"
    CHECK (("kind" = 'reversal') = ("reverses_remittance_id" IS NOT NULL));
ALTER TABLE "admin"."settlement_export"
  ADD CONSTRAINT "settlement_export_range" CHECK ("from_date" <= "to_date"),
  ADD CONSTRAINT "settlement_export_rows" CHECK ("row_count" >= 0);
