ALTER TABLE "auth"."consent_record"
  DROP CONSTRAINT "consent_record_purpose_notice_version_audience_fkey";
ALTER TABLE "auth"."consent_record"
  ADD CONSTRAINT "consent_record_purpose_notice_version_audience_fkey" FOREIGN KEY ("purpose", "notice_version", "audience")
  REFERENCES "auth"."consent_notice" ("purpose", "notice_version", "audience")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
