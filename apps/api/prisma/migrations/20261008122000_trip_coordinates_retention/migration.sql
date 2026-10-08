ALTER TABLE "trips"."trip_request" ALTER COLUMN "pickup_address" DROP NOT NULL;
ALTER TABLE "trips"."trip_request" ALTER COLUMN "dropoff_address" DROP NOT NULL;
ALTER TABLE "trips"."trip_request" ALTER COLUMN "pickup_lat" DROP NOT NULL;
ALTER TABLE "trips"."trip_request" ALTER COLUMN "pickup_lng" DROP NOT NULL;
ALTER TABLE "trips"."trip_request" ALTER COLUMN "dropoff_lat" DROP NOT NULL;
ALTER TABLE "trips"."trip_request" ALTER COLUMN "dropoff_lng" DROP NOT NULL;
ALTER TABLE "trips"."trip_request" ADD COLUMN "location_purged_at" TIMESTAMP(3);
ALTER TABLE "trips"."trip_request" ADD CONSTRAINT "trip_request_location_purge_consistent" CHECK (
  ("location_purged_at" IS NULL
     AND "pickup_lat" IS NOT NULL AND "pickup_lng" IS NOT NULL
     AND "dropoff_lat" IS NOT NULL AND "dropoff_lng" IS NOT NULL
     AND "pickup_address" IS NOT NULL AND "dropoff_address" IS NOT NULL)
  OR
  ("location_purged_at" IS NOT NULL
     AND "pickup_lat" IS NULL AND "pickup_lng" IS NULL
     AND "dropoff_lat" IS NULL AND "dropoff_lng" IS NULL
     AND "pickup_address" IS NULL AND "dropoff_address" IS NULL)
);
