CREATE TYPE "auth"."PushTokenPlatform" AS ENUM ('android', 'ios');

CREATE TABLE "auth"."push_token" (
    "push_token_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "auth"."PushTokenPlatform" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_token_pkey" PRIMARY KEY ("push_token_id")
);

CREATE UNIQUE INDEX "push_token_token_key" ON "auth"."push_token"("token");

CREATE INDEX "push_token_user_id_idx" ON "auth"."push_token"("user_id");

ALTER TABLE "auth"."push_token"
  ADD CONSTRAINT "push_token_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "auth"."user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
