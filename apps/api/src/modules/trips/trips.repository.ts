import { Injectable } from '@nestjs/common';
import type { FareConfig, TripRequest } from '@prisma/client';
import { type TripStatus, ACTIVE_TRIP_STATUSES, type ServiceType } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface CreateTripRequestData {
  passengerId: number;
  municipalityId: number;
  serviceType: ServiceType;
  paymentMethod: 'cash';
  pickupAddress: string;
  dropoffAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  distanceKm: number;
  fareTotal: number;
  commission: number;
}

@Injectable()
export class TripsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getActiveFareConfig(
    municipalityId: number,
    serviceType: ServiceType,
  ): Promise<FareConfig | null> {
    const today = new Date();
    return this.prisma.fareConfig.findFirst({
      where: {
        municipalityId,
        serviceType,
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: today } }] },
          { OR: [{ validTo: null }, { validTo: { gte: today } }] },
        ],
      },
      orderBy: { validFrom: 'desc' },
    });
  }

  async isPointInCoverage(
    municipalityId: number,
    lng: number,
    lat: number,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ covered: boolean | null }>>`
      SELECT ST_Covers(coverage, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) AS covered
      FROM tenancy.municipality
      WHERE municipality_id = ${municipalityId}
    `;
    return rows.length > 0 && rows[0]?.covered === true;
  }

  async hasActiveTripRequest(passengerId: number): Promise<boolean> {
    const n = await this.prisma.tripRequest.count({
      where: {
        passengerId,
        status: { in: [...ACTIVE_TRIP_STATUSES] },
      },
    });
    return n > 0;
  }

  async createTripRequest(data: CreateTripRequestData): Promise<TripRequest> {
    return this.prisma.tripRequest.create({
      data: {
        passengerId: data.passengerId,
        municipalityId: data.municipalityId,
        serviceType: data.serviceType,
        paymentMethod: data.paymentMethod,
        pickupAddress: data.pickupAddress,
        dropoffAddress: data.dropoffAddress,
        pickupLat: data.pickupLat,
        pickupLng: data.pickupLng,
        dropoffLat: data.dropoffLat,
        dropoffLng: data.dropoffLng,
        distance: data.distanceKm,
        fare: data.fareTotal,
        commission: data.commission,
        status: 'pending_assignment',
      },
    });
  }

  async getTripRequest(tripRequestId: number): Promise<TripRequest | null> {
    return this.prisma.tripRequest.findUnique({ where: { tripRequestId } });
  }

  async updateStatus(tripRequestId: number, status: TripStatus): Promise<void> {
    await this.prisma.tripRequest.update({
      where: { tripRequestId },
      data: { status },
    });
  }
}
