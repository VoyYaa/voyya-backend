-- CreateEnum
CREATE TYPE "tenancy"."CompanyDocumentType" AS ENUM ('chamber_of_commerce', 'tax_registry', 'transport_authorization', 'liability_insurance');

-- CreateEnum
CREATE TYPE "tenancy"."DocumentVerificationStatus" AS ENUM ('pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "tenancy"."CompanyDecision" AS ENUM ('approved', 'documents_requested', 'rejected');

-- CreateEnum
CREATE TYPE "fleet"."DriverDocumentType" AS ENUM ('license', 'soat', 'vehicle_inspection', 'operation_card');

-- AlterTable
ALTER TABLE "tenancy"."company"
  ADD COLUMN "contact_first_name" TEXT,
  ADD COLUMN "contact_last_name" TEXT,
  ADD COLUMN "contact_phone" TEXT;

-- CreateIndex
CREATE INDEX "company_status_registered_at_idx" ON "tenancy"."company"("status", "registered_at");

-- CreateTable
CREATE TABLE "tenancy"."company_document" (
    "company_document_id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "type" "tenancy"."CompanyDocumentType" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "verification" "tenancy"."DocumentVerificationStatus" NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "issued_at" DATE,
    "expires_at" DATE,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by" INTEGER,
    "verified_at" TIMESTAMP(3),

    CONSTRAINT "company_document_pkey" PRIMARY KEY ("company_document_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_document_company_id_type_key" ON "tenancy"."company_document"("company_id", "type");

-- CreateIndex
CREATE INDEX "company_document_company_id_verification_idx" ON "tenancy"."company_document"("company_id", "verification");

-- CreateTable
CREATE TABLE "tenancy"."company_review" (
    "company_review_id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "decision" "tenancy"."CompanyDecision" NOT NULL,
    "note" TEXT,
    "acknowledged_routing_limitation" BOOLEAN NOT NULL DEFAULT false,
    "municipality_active_company_id" INTEGER,
    "municipality_active_company_name" TEXT,
    "requested_document_types" "tenancy"."CompanyDocumentType"[] NOT NULL DEFAULT ARRAY[]::"tenancy"."CompanyDocumentType"[],
    "reviewed_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_review_pkey" PRIMARY KEY ("company_review_id")
);

-- CreateIndex
CREATE INDEX "company_review_company_id_created_at_idx" ON "tenancy"."company_review"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "company_review_decision_created_at_idx" ON "tenancy"."company_review"("decision", "created_at");

-- CreateTable
CREATE TABLE "fleet"."driver_document" (
    "driver_document_id" SERIAL NOT NULL,
    "driver_id" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL,
    "type" "fleet"."DriverDocumentType" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "issued_at" DATE,
    "expires_at" DATE NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_document_pkey" PRIMARY KEY ("driver_document_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_document_driver_id_type_key" ON "fleet"."driver_document"("driver_id", "type");

-- CreateIndex
CREATE INDEX "driver_document_company_id_expires_at_idx" ON "fleet"."driver_document"("company_id", "expires_at");

-- AddForeignKey
ALTER TABLE "tenancy"."company_document" ADD CONSTRAINT "company_document_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "tenancy"."company"("company_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenancy"."company_document" ADD CONSTRAINT "company_document_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "auth"."user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenancy"."company_review" ADD CONSTRAINT "company_review_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "tenancy"."company"("company_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenancy"."company_review" ADD CONSTRAINT "company_review_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."driver_document" ADD CONSTRAINT "driver_document_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "fleet"."driver"("driver_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."driver_document" ADD CONSTRAINT "driver_document_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint: a platform_admin never has a company (ADR-021 §1.1)
ALTER TABLE "auth"."user"
  ADD CONSTRAINT "user_platform_admin_has_no_company"
  CHECK ("role" <> 'platform_admin' OR "company_id" IS NULL);
