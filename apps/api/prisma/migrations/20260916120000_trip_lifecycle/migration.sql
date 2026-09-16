-- AlterTable
ALTER TABLE "trips"."trip_request" ADD COLUMN     "arrived_at" TIMESTAMP(3),
ADD COLUMN     "cash_collected_at" TIMESTAMP(3),
ADD COLUMN     "penalty_recorded" BOOLEAN NOT NULL DEFAULT false;
