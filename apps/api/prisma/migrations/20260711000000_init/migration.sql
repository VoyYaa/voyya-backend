
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "admin";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "assignment";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "fleet";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tenancy";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "trips";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "users";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "tenancy"."CompanyStatus" AS ENUM ('pending', 'active', 'suspended', 'rejected');

-- CreateEnum
CREATE TYPE "fleet"."DriverStatus" AS ENUM ('available', 'on_trip', 'off_shift', 'inactive', 'suspended', 
'documents_blocked');

-- CreateEnum
CREATE TYPE "trips"."TripStatus" AS ENUM ('pending_assignment', 'assigned', 'driver_en_route', 'in_progress', 
'completed', 'cancelled_by_passenger', 'cancelled_by_driver', 'no_driver', 'no_show', 'expired');

-- CreateEnum
CREATE TYPE "assignment"."AssignmentStatus" AS ENUM ('created', 'notified', 'accepted', 'rejected', 'timeout', 
'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "trips"."ServiceType" AS ENUM ('taxi', 'motorcycle', 'comfort', 'delivery');

-- CreateEnum
CREATE TYPE "trips"."PaymentMethod" AS ENUM ('cash', 'nequi', 'daviplata', 'card');

-- CreateTable
CREATE TABLE "tenancy"."company" (
    "company_id" SERIAL NOT NULL,
    "legal_name" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "municipality_id" INTEGER NOT NULL,
    "vehicle_count" INTEGER,
    "contact_email" TEXT,
    "status" "tenancy"."CompanyStatus" NOT NULL DEFAULT 'active',
    "membership_fee" DECIMAL(12,2),
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "tenancy"."municipality" (
    "municipality_id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "coverage_polygon" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "municipality_pkey" PRIMARY KEY ("municipality_id")
);

-- CreateTable
CREATE TABLE "auth"."user" (
    "user_id" SERIAL NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" TEXT NOT NULL,
    "account_status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "auth"."refresh_token" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."otp_code" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users"."passenger" (
    "passenger_id" INTEGER NOT NULL,
    "preferred_payment_method" "trips"."PaymentMethod" NOT NULL DEFAULT 'cash',
    "main_address" TEXT,
    "trusted_contact" TEXT,

    CONSTRAINT "passenger_pkey" PRIMARY KEY ("passenger_id")
);

-- CreateTable
CREATE TABLE "fleet"."driver" (
    "driver_id" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL,
    "national_id" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "license" TEXT,
    "average_rating" DOUBLE PRECISION,
    "status" "fleet"."DriverStatus" NOT NULL DEFAULT 'off_shift',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "blocked_until" TIMESTAMP(3),
    "current_lat" DOUBLE PRECISION,
    "current_lng" DOUBLE PRECISION,
    "location_updated_at" TIMESTAMP(3),
    "current_vehicle_id" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "fleet"."vehicle" (
    "vehicle_id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL,
    "plate" TEXT NOT NULL,
    "model" TEXT,
    "year" INTEGER,
    "operation_card" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("vehicle_id")
);

-- CreateTable
CREATE TABLE "trips"."trip_request" (
    "trip_request_id" SERIAL NOT NULL,
    "passenger_id" INTEGER NOT NULL,
    "municipality_id" INTEGER NOT NULL,
    "service_type" "trips"."ServiceType" NOT NULL DEFAULT 'taxi',
    "payment_method" "trips"."PaymentMethod" NOT NULL DEFAULT 'cash',
    "pickup_address" TEXT NOT NULL,
    "dropoff_address" TEXT NOT NULL,
    "pickup_lat" DOUBLE PRECISION NOT NULL,
    "pickup_lng" DOUBLE PRECISION NOT NULL,
    "dropoff_lat" DOUBLE PRECISION NOT NULL,
    "dropoff_lng" DOUBLE PRECISION NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "trips"."TripStatus" NOT NULL DEFAULT 'pending_assignment',
    "assigned_at" TIMESTAMP(3),
    "type" TEXT NOT NULL DEFAULT 'immediate',
    "scheduled_pickup_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "distance" DOUBLE PRECISION,
    "fare" DECIMAL(12,2) NOT NULL,
    "commission" DECIMAL(12,2) NOT NULL,
    "net_earnings" DECIMAL(12,2),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trip_request_pkey" PRIMARY KEY ("trip_request_id")
);

-- CreateTable
CREATE TABLE "trips"."fare_config" (
    "fare_config_id" SERIAL NOT NULL,
    "municipality_id" INTEGER NOT NULL,
    "service_type" "trips"."ServiceType" NOT NULL DEFAULT 'taxi',
    "base_fare" DECIMAL(12,2) NOT NULL,
    "night_surcharge_pct" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "holiday_surcharge_pct" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "commission_pct" DECIMAL(5,2) NOT NULL DEFAULT 8,
    "valid_from" DATE,
    "valid_to" DATE,

    CONSTRAINT "fare_config_pkey" PRIMARY KEY ("fare_config_id")
);

-- CreateTable
CREATE TABLE "assignment"."assignment" (
    "assignment_id" SERIAL NOT NULL,
    "trip_request_id" INTEGER NOT NULL,
    "driver_id" INTEGER NOT NULL,
    "vehicle_id" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL,
    "status" "assignment"."AssignmentStatus" NOT NULL DEFAULT 'created',
    "assigned_by" TEXT NOT NULL DEFAULT 'system',
    "attempt_order" INTEGER NOT NULL DEFAULT 1,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,

    CONSTRAINT "assignment_pkey" PRIMARY KEY ("assignment_id")
);

-- CreateTable
CREATE TABLE "admin"."system_parameter" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "municipality_id" INTEGER,

    CONSTRAINT "system_parameter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_tax_id_key" ON "tenancy"."company"("tax_id");

-- CreateIndex
CREATE INDEX "company_municipality_id_idx" ON "tenancy"."company"("municipality_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "auth"."user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_phone_key" ON "auth"."user"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "auth"."refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_revoked_idx" ON "auth"."refresh_token"("user_id", "revoked");

-- CreateIndex
CREATE INDEX "refresh_token_expires_at_idx" ON "auth"."refresh_token"("expires_at");

-- CreateIndex
CREATE INDEX "otp_code_phone_created_at_idx" ON "auth"."otp_code"("phone", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "driver_national_id_key" ON "fleet"."driver"("national_id");

-- CreateIndex
CREATE INDEX "driver_company_id_status_idx" ON "fleet"."driver"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_plate_key" ON "fleet"."vehicle"("plate");

-- CreateIndex
CREATE INDEX "vehicle_company_id_status_idx" ON "fleet"."vehicle"("company_id", "status");

-- CreateIndex
CREATE INDEX "trip_request_municipality_id_status_requested_at_idx" ON "trips"."trip_request"("municipality_id", 
"status", "requested_at");

-- CreateIndex
CREATE INDEX "trip_request_service_type_status_idx" ON "trips"."trip_request"("service_type", "status");

-- CreateIndex
CREATE INDEX "fare_config_municipality_id_service_type_idx" ON "trips"."fare_config"("municipality_id", 
"service_type");

-- CreateIndex
CREATE INDEX "assignment_driver_id_status_assigned_at_idx" ON "assignment"."assignment"("driver_id", "status", 
"assigned_at");

-- CreateIndex
CREATE INDEX "assignment_trip_request_id_status_idx" ON "assignment"."assignment"("trip_request_id", "status");

-- CreateIndex
CREATE INDEX "assignment_company_id_status_idx" ON "assignment"."assignment"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "system_parameter_key_municipality_id_key" ON "admin"."system_parameter"("key", "municipality_id");

-- AddForeignKey
ALTER TABLE "tenancy"."company" ADD CONSTRAINT "company_municipality_id_fkey" FOREIGN KEY ("municipality_id") 
REFERENCES "tenancy"."municipality"("municipality_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES 
"auth"."user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users"."passenger" ADD CONSTRAINT "passenger_passenger_id_fkey" FOREIGN KEY ("passenger_id") REFERENCES 
"auth"."user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."driver" ADD CONSTRAINT "driver_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES 
"auth"."user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."driver" ADD CONSTRAINT "driver_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES 
"tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."driver" ADD CONSTRAINT "driver_current_vehicle_id_fkey" FOREIGN KEY ("current_vehicle_id") 
REFERENCES "fleet"."vehicle"("vehicle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."vehicle" ADD CONSTRAINT "vehicle_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES 
"tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips"."trip_request" ADD CONSTRAINT "trip_request_passenger_id_fkey" FOREIGN KEY ("passenger_id") 
REFERENCES "users"."passenger"("passenger_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips"."trip_request" ADD CONSTRAINT "trip_request_municipality_id_fkey" FOREIGN KEY ("municipality_id") 
REFERENCES "tenancy"."municipality"("municipality_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips"."fare_config" ADD CONSTRAINT "fare_config_municipality_id_fkey" FOREIGN KEY ("municipality_id") 
REFERENCES "tenancy"."municipality"("municipality_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment"."assignment" ADD CONSTRAINT "assignment_trip_request_id_fkey" FOREIGN KEY ("trip_request_id") 
REFERENCES "trips"."trip_request"("trip_request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment"."assignment" ADD CONSTRAINT "assignment_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES 
"fleet"."driver"("driver_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment"."assignment" ADD CONSTRAINT "assignment_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") 
REFERENCES "fleet"."vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment"."assignment" ADD CONSTRAINT "assignment_company_id_fkey" FOREIGN KEY ("company_id") 
REFERENCES "tenancy"."company"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin"."system_parameter" ADD CONSTRAINT "system_parameter_municipality_id_fkey" FOREIGN KEY 
("municipality_id") REFERENCES "tenancy"."municipality"("municipality_id") ON DELETE SET NULL ON UPDATE CASCADE;



