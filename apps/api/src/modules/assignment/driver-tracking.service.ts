import { Injectable } from '@nestjs/common';
import type { ConsentStatus, DriverLocationSharing, DriverTracking, TripStatus } from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { isInTripWindow } from '../../shared/trip-window';
import { ConsentQueryService } from '../auth/consent-query.service';
import { coversLocationSharing } from '../auth/consent-status';
import { DriverRepository } from './driver.repository';

export interface TrackedTrip {
  tripRequestId: number;
  companyId: number | null;
  status: TripStatus;
}

@Injectable()
export class DriverTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: DriverRepository,
    private readonly consents: ConsentQueryService,
    private readonly env: EnvService,
  ) {}

  async forPassenger(trip: TrackedTrip): Promise<DriverTracking | null> {
    if (trip.companyId === null || !isInTripWindow(trip.status)) return null;
    const companyId = trip.companyId;
    const staleAfterSec = this.env.get('DRIVER_LOCATION_SHARE_STALE_SEC');
    const hideAfterSec = this.env.get('DRIVER_LOCATION_SHARE_HIDE_SEC');

    const snapshot = await this.prisma.runInTenant(companyId, async (tx) => {
      const driverId = await this.repo.getAcceptedDriverId(tx, trip.tripRequestId, companyId);
      const consented =
        driverId !== null && coversLocationSharing(await this.consents.locationStatus(driverId));
      return this.repo.getTrackingSnapshot(tx, {
        tripRequestId: trip.tripRequestId,
        companyId,
        driverId: consented ? driverId : null,
        hideSec: hideAfterSec,
      });
    });
    if (snapshot === null) return null;

    const { lat, lng, ageSec } = snapshot;
    return {
      window_age_sec: snapshot.windowAgeSec,
      stale_after_sec: staleAfterSec,
      hide_after_sec: hideAfterSec,
      position: lat !== null && lng !== null && ageSec !== null ? { lat, lng, age_sec: ageSec } : null,
    };
  }

  sharingFor(tripRequestId: number | null, consent: ConsentStatus): DriverLocationSharing | null {
    if (tripRequestId === null || !coversLocationSharing(consent)) return null;
    return {
      trip_request_id: tripRequestId,
      interval_sec: this.env.get('DRIVER_LOCATION_SHARE_INTERVAL_SEC'),
    };
  }
}
