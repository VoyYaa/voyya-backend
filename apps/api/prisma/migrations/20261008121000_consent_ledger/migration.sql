CREATE TYPE "auth"."ConsentAction" AS ENUM ('granted', 'revoked');
CREATE TYPE "auth"."NoticeAudience" AS ENUM ('driver', 'passenger');

CREATE TABLE "auth"."consent_notice" (
    "purpose" "auth"."ConsentPurpose" NOT NULL,
    "notice_version" TEXT NOT NULL,
    "audience" "auth"."NoticeAudience" NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "body" TEXT NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),
    CONSTRAINT "consent_notice_pkey" PRIMARY KEY ("purpose", "notice_version", "audience")
);
CREATE UNIQUE INDEX "consent_notice_sha256_key" ON "auth"."consent_notice" ("sha256");

ALTER TABLE "auth"."consent_record" RENAME COLUMN "granted_at" TO "recorded_at";
ALTER TABLE "auth"."consent_record" ALTER COLUMN "recorded_at" SET DEFAULT timezone('utc', now());
ALTER TABLE "auth"."consent_record" ADD COLUMN "action" "auth"."ConsentAction" NOT NULL DEFAULT 'granted';
ALTER TABLE "auth"."consent_record" ADD COLUMN "audience" "auth"."NoticeAudience";
DROP INDEX "auth"."consent_record_user_id_purpose_notice_version_key";
CREATE INDEX "consent_record_user_id_purpose_recorded_at_consent_record_i_idx"
  ON "auth"."consent_record" ("user_id", "purpose", "recorded_at" DESC, "consent_record_id" DESC);
ALTER TABLE "auth"."consent_record"
  ADD CONSTRAINT "consent_record_purpose_notice_version_audience_fkey" FOREIGN KEY ("purpose", "notice_version", "audience")
  REFERENCES "auth"."consent_notice" ("purpose", "notice_version", "audience")
  ON DELETE RESTRICT ON UPDATE CASCADE;
