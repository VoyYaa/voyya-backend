CREATE TYPE "auth"."ConsentPurpose" AS ENUM ('location');

CREATE TABLE "auth"."consent_record" (
    "consent_record_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "purpose" "auth"."ConsentPurpose" NOT NULL,
    "notice_version" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("consent_record_id")
);

CREATE UNIQUE INDEX "consent_record_user_id_purpose_notice_version_key"
  ON "auth"."consent_record" ("user_id", "purpose", "notice_version");

ALTER TABLE "auth"."consent_record"
  ADD CONSTRAINT "consent_record_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "auth"."user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
