ALTER TABLE "auth"."consent_record"
  DROP CONSTRAINT "consent_record_user_id_fkey";
ALTER TABLE "auth"."consent_record"
  ADD CONSTRAINT "consent_record_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "auth"."user" ("user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_voyya') THEN
    REVOKE DELETE ON auth."user" FROM app_voyya;
  END IF;
END
$$;
