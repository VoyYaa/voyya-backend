import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import {
  type AcceptAssignmentDTO,
  type AcceptAssignmentResult,
  type AssignmentCancelledByDriverEvent,
  type AssignmentCreatedEvent,
  type AssignmentExpiredEvent,
  type AssignmentNotification,
  type AssignmentRejectedEvent,
  type AssignmentStatus,
  ASSIGNMENT_EVENTS,
  type AssignedDriverSummary,
  type CancelAssignmentByDriverDTO,
  type CancelAssignmentByDriverResult,
  type DriverAssignedEvent,
  type RejectAssignmentDTO,
  type ServiceType,
  type TripRequestCancelledEvent,
  type TripRequestCreatedEvent,
  type TripRequestNoDriverEvent,
  TRIPS_EVENTS,
} from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { isDeadlock, retryOnDeadlock } from '../../shared/deadlock';
import { isUniqueViolation } from '../../shared/unique-violation';
import { CompanyDirectory } from '../tenancy/company-directory';
import { DispatchCompaniesResolver } from '../tenancy/dispatch-companies.resolver';
import { calculateEta, haversineKm } from '../trips/domain/geo';
import { CompanyCommissionReader } from '../service-config/company-commission.reader';
import {
  OperationalParamsService,
  type OperationalParams,
} from '../service-config/operational-params.service';
import { ASSIGNMENT_MESSAGES } from './assignment.messages';
import {
  AssignmentRepository,
  type AssignedDriverRow,
  type PassengerData,
  type TripRequestInfo,
} from './assignment.repository';
import { CandidateRepository } from './candidate.repository';
import { type CompanyCandidate, pickNearest } from './nearest-candidate';
import { PUSH_PROVIDER, type PushProvider } from './ports/push-provider.port';
import { TripClosingService } from './trip-closing.service';
import { summarizeError } from '../../infrastructure/observability/safe-error';

export class TripRequestAlreadyTakenError extends Error {
  constructor() {
    super('Trip request already taken');
    this.name = 'TripRequestAlreadyTakenError';
  }
}

export class CompanyCommissionMissingError extends Error {
  constructor(readonly companyId: number) {
    super(`Company ${companyId} has no current commission`);
    this.name = 'CompanyCommissionMissingError';
  }
}

interface CurrentOffer {
  assignmentId: number;
  companyId: number;
}

interface ChainContext {
  tripRequestId: number;
  municipalityId: number;
  serviceType: ServiceType;
  requestedCompanyId: number | null;
  origin: { lat: number; lng: number };
  info: TripRequestInfo;
  params: OperationalParams;
  attempted: Set<number>;
  order: number;
  expanded: boolean;
  currentOffer: CurrentOffer | null;
}

type AcceptOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_driver' }
  | { kind: 'expired' }
  | { kind: 'already_taken' }
  | { kind: 'accepted'; tripRequestId: number; vehicleId: number; passenger: PassengerData | null };

@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);
  private readonly chains = new Map<number, ChainContext>();
  private readonly timers = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly candidateRepo: CandidateRepository,
    private readonly repo: AssignmentRepository,
    private readonly paramsService: OperationalParamsService,
    private readonly emitter: EventEmitter2,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    private readonly tripClosing: TripClosingService,
    private readonly dispatchCompanies: DispatchCompaniesResolver,
    private readonly commissions: CompanyCommissionReader,
    private readonly companyDirectory: CompanyDirectory,
  ) {}

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_CREATED)
  async onTripRequestCreated(ev: TripRequestCreatedEvent): Promise<void> {
    try {
      await this.start(ev.trip_request_id, ev.municipality_id, ev.origin);
    } catch (e) {
      this.logger.error(`Failed to start assignment tripRequest=${ev.trip_request_id}: ${summarizeError(e)}`);
    }
  }

  private async start(
    tripRequestId: number,
    municipalityId: number,
    origin: { lat: number; lng: number },
  ): Promise<void> {
    const info = await this.repo.getTripRequestInfo(tripRequestId);
    if (!info || info.status !== 'pending_assignment') return;

    const params = await this.paramsService.get(municipalityId, info.serviceType);
    const ctx: ChainContext = {
      tripRequestId,
      municipalityId,
      serviceType: info.serviceType,
      requestedCompanyId: info.requestedCompanyId,
      origin,
      info,
      params,
      attempted: new Set<number>(),
      order: 0,
      expanded: false,
      currentOffer: null,
    };
    this.chains.set(tripRequestId, ctx);
    await this.tryNext(ctx);
  }

  private async tryNext(ctx: ChainContext): Promise<void> {
    if (ctx.order >= ctx.params.maxAutoRetries) {
      return this.finishNoDriver(ctx);
    }

    const cand = await this.findNearestCandidate(ctx);
    if (!cand) {
      if (!ctx.expanded) {
        ctx.expanded = true;
        return this.tryNext(ctx);
      }
      return this.finishNoDriver(ctx);
    }

    const expiresAt = new Date(Date.now() + ctx.params.acceptanceTimeoutSec * 1000);
    const attemptOrder = ctx.order + 1;
    const assignment = await this.prisma.runInTenant(cand.companyId, (tx) =>
      this.repo.createOfferIfDriverFree(tx, {
        tripRequestId: ctx.tripRequestId,
        driverId: cand.driverId,
        vehicleId: cand.vehicleId,
        companyId: cand.companyId,
        attemptOrder,
        expiresAt,
      }),
    );
    ctx.attempted.add(cand.driverId);
    if (!assignment) return this.tryNext(ctx);

    ctx.order = attemptOrder;
    ctx.currentOffer = { assignmentId: assignment.assignmentId, companyId: cand.companyId };

    const notification: AssignmentNotification = {
      assignment_id: assignment.assignmentId,
      trip_request_id: ctx.tripRequestId,
      origin: {
        address: ctx.info.pickupAddress,
        lat: ctx.origin.lat,
        lng: ctx.origin.lng,
      },
      dropoff_neighborhood: neighborhoodOf(ctx.info.dropoffAddress),
      total_fare: Math.round(ctx.info.fare),
      distance_to_origin_m: Math.round(cand.distanceM),
      expires_at: expiresAt.toISOString(),
      seconds_to_respond: ctx.params.acceptanceTimeoutSec,
    };
    const created: AssignmentCreatedEvent = {
      assignment_id: assignment.assignmentId,
      trip_request_id: ctx.tripRequestId,
      driver_id: cand.driverId,
      company_id: cand.companyId,
      attempt_order: ctx.order,
      expires_at: expiresAt.toISOString(),
      occurred_at: new Date().toISOString(),
    };
    this.emitter.emit(ASSIGNMENT_EVENTS.ASSIGNMENT_CREATED, created);

    this.armTimeout(assignment.assignmentId, ctx.tripRequestId, ctx.params.acceptanceTimeoutSec);

    await this.push.sendAssignment({ driverId: cand.driverId }, notification);
  }

  private async findNearestCandidate(ctx: ChainContext): Promise<CompanyCandidate | null> {
    const companyIds = await this.dispatchCompanies.resolve(ctx.municipalityId, {
      serviceType: ctx.serviceType,
      requestedCompanyId: ctx.requestedCompanyId,
    });
    const radiusKm = ctx.expanded ? ctx.params.expansionRadiusKm : ctx.params.searchRadiusKm;
    const nearestPerCompany: CompanyCandidate[] = [];
    for (const companyId of companyIds) {
      const [nearest] = await this.prisma.runInTenant(companyId, (tx) =>
        this.candidateRepo.findCandidates(tx, {
          companyId,
          tripRequestId: ctx.tripRequestId,
          lat: ctx.origin.lat,
          lng: ctx.origin.lng,
          radiusKm,
          tiebreakWindowHours: ctx.params.tiebreakWindowHours,
          locationStaleMin: ctx.params.locationStaleMin,
          limit: 1,
          exclude: [...ctx.attempted],
        }),
      );
      if (nearest) nearestPerCompany.push({ ...nearest, companyId });
    }
    return pickNearest(nearestPerCompany);
  }

  private finishNoDriver(ctx: ChainContext): void {
    this.chains.delete(ctx.tripRequestId);
    const finalRadius = ctx.expanded ? ctx.params.expansionRadiusKm : ctx.params.searchRadiusKm;
    this.emitNoDriver(ctx.tripRequestId, ctx.order, finalRadius);
  }

  private emitNoDriver(tripRequestId: number, attempts: number, finalRadiusKm: number): void {
    const ev: TripRequestNoDriverEvent = {
      trip_request_id: tripRequestId,
      attempts_made: attempts,
      final_radius_km: finalRadiusKm > 0 ? finalRadiusKm : 1,
      occurred_at: new Date().toISOString(),
    };
    this.emitter.emit(TRIPS_EVENTS.TRIP_REQUEST_NO_DRIVER, ev);
  }

  private armTimeout(assignmentId: number, tripRequestId: number, seconds: number): void {
    const t = setTimeout(() => {
      void this.handleExpiration(assignmentId, tripRequestId);
    }, seconds * 1000);
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(assignmentId, t);
  }

  private clearTimer(assignmentId: number): void {
    const t = this.timers.get(assignmentId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(assignmentId);
    }
  }

  private async handleExpiration(assignmentId: number, tripRequestId: number): Promise<void> {
    this.clearTimer(assignmentId);
    const ctx = this.chains.get(tripRequestId);
    const offer = ctx?.currentOffer;
    if (!ctx || !offer || offer.assignmentId !== assignmentId) return;
    try {
      const expired = await this.prisma.runInTenant(offer.companyId, (tx) =>
        this.repo.markTimeout(tx, assignmentId, offer.companyId),
      );
      if (!expired) return;
      ctx.currentOffer = null;

      const ev: AssignmentExpiredEvent = {
        assignment_id: assignmentId,
        trip_request_id: tripRequestId,
        driver_id: expired.driverId,
        attempt_order: ctx.order,
        occurred_at: new Date().toISOString(),
      };
      this.emitter.emit(ASSIGNMENT_EVENTS.ASSIGNMENT_EXPIRED, ev);
      await this.tryNext(ctx);
    } catch (e) {
      this.logger.error(`Expiration failed assignment=${assignmentId}: ${summarizeError(e)}`);
    }
  }

  async accept(
    assignmentId: number,
    driverId: number,
    companyId: number,
    _dto: AcceptAssignmentDTO,
  ): Promise<AcceptAssignmentResult> {
    let outcome: AcceptOutcome;
    try {
      outcome = await retryOnDeadlock(() => this.takeTrip(assignmentId, driverId, companyId));
    } catch (e) {
      if (e instanceof CompanyCommissionMissingError) {
        this.logger.error(`Take aborted assignment=${assignmentId} company=${e.companyId}: no current commission`);
        throw new InternalServerErrorException({
          code: 'COMMISSION_NOT_CONFIGURED',
          message: ASSIGNMENT_MESSAGES.commissionNotConfigured,
        });
      }
      if (e instanceof TripRequestAlreadyTakenError || isUniqueViolation(e)) return this.alreadyTaken();
      if (isDeadlock(e)) {
        this.logger.warn(`Take lost to a deadlock assignment=${assignmentId} company=${companyId}`);
        return this.alreadyTaken();
      }
      throw e;
    }

    switch (outcome.kind) {
      case 'not_found':
        throw new NotFoundException({
          code: 'ASSIGNMENT_NOT_FOUND',
          message: ASSIGNMENT_MESSAGES.assignmentNotFound,
        });
      case 'not_driver':
        throw new ForbiddenException({
          code: 'NOT_THE_DRIVER',
          message: ASSIGNMENT_MESSAGES.notTheDriver,
        });
      case 'expired':
        return { result: 'expired', message: ASSIGNMENT_MESSAGES.offerExpired };
      case 'already_taken':
        return this.alreadyTaken();
      case 'accepted':
        return this.finishAcceptance(assignmentId, driverId, companyId, outcome);
    }
  }

  private takeTrip(assignmentId: number, driverId: number, companyId: number): Promise<AcceptOutcome> {
    return this.prisma.runInTenant<AcceptOutcome>(companyId, async (tx) => {
      const a = await this.repo.getAssignment(tx, assignmentId, companyId);
      if (!a) return { kind: 'not_found' };
      if (a.driverId !== driverId) return { kind: 'not_driver' };

      const expired = a.expiresAt !== null && a.expiresAt.getTime() < Date.now();
      if (a.status === 'timeout' || (expired && a.status === 'notified')) {
        return { kind: 'expired' };
      }
      if (a.status !== 'notified') return { kind: 'already_taken' };

      const commission = await this.commissions.getCurrent(tx, companyId);
      if (!commission) throw new CompanyCommissionMissingError(companyId);

      const assigned = await this.repo.markTripRequestAssigned(tx, {
        tripRequestId: a.tripRequestId,
        assignmentId,
        driverId,
        companyId,
      });
      if (!assigned) return { kind: 'already_taken' };

      const taken = await this.repo.takeDriver(tx, driverId, companyId);
      if (!taken) throw new TripRequestAlreadyTakenError();

      const acceptedOk = await this.repo.markAssignmentAccepted(tx, assignmentId, companyId);
      if (!acceptedOk) throw new TripRequestAlreadyTakenError();

      const passenger = await this.repo.getPassengerData(tx, a.tripRequestId);
      return { kind: 'accepted', tripRequestId: a.tripRequestId, vehicleId: a.vehicleId, passenger };
    });
  }

  private finishAcceptance(
    assignmentId: number,
    driverId: number,
    companyId: number,
    accepted: Extract<AcceptOutcome, { kind: 'accepted' }>,
  ): AcceptAssignmentResult {
    this.clearTimer(assignmentId);
    this.chains.delete(accepted.tripRequestId);

    const ev: DriverAssignedEvent = {
      trip_request_id: accepted.tripRequestId,
      assignment_id: assignmentId,
      driver_id: driverId,
      vehicle_id: accepted.vehicleId,
      company_id: companyId,
      occurred_at: new Date().toISOString(),
    };
    this.emitter.emit(ASSIGNMENT_EVENTS.DRIVER_ASSIGNED, ev);

    return {
      result: 'accepted',
      assignment_id: assignmentId,
      trip_request_id: accepted.tripRequestId,
      trip_request_status: 'assigned',
      passenger: {
        name: accepted.passenger?.name ?? '',
        contact_phone: accepted.passenger?.phone ?? null,
        pickup_address: accepted.passenger?.pickupAddress ?? '',
      },
    };
  }

  private alreadyTaken(): AcceptAssignmentResult {
    return { result: 'already_taken', message: ASSIGNMENT_MESSAGES.alreadyTaken };
  }

  async getAssignedDriverSummary(
    tripRequestId: number,
    includeContact: boolean,
  ): Promise<AssignedDriverSummary | null> {
    const info = await this.repo.getTripRequestInfo(tripRequestId);
    if (!info || info.companyId === null) return null;
    const companyId = info.companyId;

    const company = await this.companyDirectory.getRef(companyId);
    if (!company) return null;

    const row = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.getAssignedDriver(tx, tripRequestId, companyId),
    );
    if (!row) return null;

    if (!includeContact) {
      return {
        name: row.name,
        plate: row.plate,
        model: row.model,
        contact_phone: null,
        eta: null,
        company,
      };
    }

    const params = await this.paramsService.get(info.municipalityId, info.serviceType);
    const eta = this.frozenOrCurrentEta(info, row, params.avgSpeedKmh);

    return {
      name: row.name,
      plate: row.plate,
      model: row.model,
      contact_phone: row.phone,
      eta,
      company,
    };
  }

  private frozenOrCurrentEta(
    info: TripRequestInfo,
    row: AssignedDriverRow,
    avgSpeedKmh: number,
  ): AssignedDriverSummary['eta'] {
    if (info.pickupDistanceAtAssignmentM !== null) {
      return calculateEta(info.pickupDistanceAtAssignmentM / 1000, avgSpeedKmh);
    }
    if (row.lat === null || row.lng === null) return null;
    return calculateEta(
      haversineKm({ lat: row.lat, lng: row.lng }, { lat: info.pickupLat, lng: info.pickupLng }),
      avgSpeedKmh,
    );
  }

  getOwnedAssignment(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
    driverId: number,
    companyId: number,
    allow: readonly AssignmentStatus[] = ['accepted'],
  ): Promise<{ assignmentId: number } | null> {
    return this.repo.getAssignmentForDriver(tx, tripRequestId, driverId, companyId, allow);
  }

  async listNearby(driverId: number, companyId: number): Promise<AssignmentNotification[]> {
    const { offers, location } = await this.prisma.runInTenant(companyId, async (tx) => ({
      offers: await this.repo.getPendingOffers(tx, driverId, companyId),
      location: await this.repo.getDriverLocation(tx, driverId, companyId),
    }));

    const now = Date.now();
    return offers.map((o) => ({
      assignment_id: o.assignmentId,
      trip_request_id: o.tripRequestId,
      origin: { address: o.pickupAddress, lat: o.pickupLat, lng: o.pickupLng },
      dropoff_neighborhood: neighborhoodOf(o.dropoffAddress),
      total_fare: Math.round(o.fare),
      distance_to_origin_m:
        location?.lat != null && location.lng != null
          ? Math.round(
              haversineKm(
                { lat: location.lat, lng: location.lng },
                { lat: o.pickupLat, lng: o.pickupLng },
              ) * 1000,
            )
          : 0,
      expires_at: o.expiresAt.toISOString(),
      seconds_to_respond: Math.max(1, Math.ceil((o.expiresAt.getTime() - now) / 1000)),
    }));
  }

  async reject(
    assignmentId: number,
    driverId: number,
    companyId: number,
    dto: RejectAssignmentDTO,
  ): Promise<{ ok: true }> {
    const r = await this.prisma.runInTenant(companyId, async (tx) => {
      const a = await this.repo.getAssignment(tx, assignmentId, companyId);
      if (!a) return { kind: 'not_found' as const };
      if (a.driverId !== driverId) return { kind: 'not_driver' as const };
      if (a.status !== 'notified') return { kind: 'invalid_status' as const };
      await this.repo.markRejected(tx, assignmentId, companyId, dto.reason ?? null);
      return { kind: 'ok' as const, tripRequestId: a.tripRequestId, driverId };
    });

    if (r.kind === 'not_found') {
      throw new NotFoundException({
        code: 'ASSIGNMENT_NOT_FOUND',
        message: ASSIGNMENT_MESSAGES.assignmentNotFound,
      });
    }
    if (r.kind === 'not_driver') {
      throw new ForbiddenException({ code: 'NOT_THE_DRIVER', message: ASSIGNMENT_MESSAGES.notTheDriver });
    }
    if (r.kind === 'invalid_status') {
      throw new ConflictException({ code: 'INVALID_STATUS', message: ASSIGNMENT_MESSAGES.notNotified });
    }

    this.clearTimer(assignmentId);
    const ev: AssignmentRejectedEvent = {
      assignment_id: assignmentId,
      trip_request_id: r.tripRequestId,
      driver_id: r.driverId,
      reason: dto.reason ?? null,
      occurred_at: new Date().toISOString(),
    };
    this.emitter.emit(ASSIGNMENT_EVENTS.ASSIGNMENT_REJECTED, ev);

    const ctx = this.chains.get(r.tripRequestId);
    if (ctx) {
      ctx.currentOffer = null;
      await this.tryNext(ctx);
    }
    return { ok: true };
  }

  async cancelByDriver(
    assignmentId: number,
    driverId: number,
    companyId: number,
    dto: CancelAssignmentByDriverDTO,
  ): Promise<CancelAssignmentByDriverResult> {
    const r = await this.prisma.runInTenant(companyId, async (tx) => {
      const a = await this.repo.getAssignment(tx, assignmentId, companyId);
      if (!a) return { kind: 'not_found' as const };
      if (a.driverId !== driverId) return { kind: 'not_driver' as const };
      if (a.status !== 'accepted') return { kind: 'invalid_status' as const };

      const reopened = await this.repo.reopenTripRequest(tx, a.tripRequestId);
      if (reopened) {
        await this.repo.markCancelledByDriver(tx, assignmentId, companyId, dto.reason);
        await this.repo.releaseDriver(tx, driverId, companyId);
        return {
          kind: 'ok' as const,
          tripRequestId: a.tripRequestId,
          status: 'pending_assignment' as const,
        };
      }

      const closed = await this.tripClosing.closeTripInTx(tx, companyId, {
        tripRequestId: a.tripRequestId,
        to: 'cancelled_by_driver',
        cancellationReason: dto.reason,
        driverId,
      });
      if (closed.kind === 'applied' || closed.kind === 'idempotent') {
        return {
          kind: 'ok' as const,
          tripRequestId: a.tripRequestId,
          status: 'cancelled_by_driver' as const,
        };
      }
      return { kind: 'invalid_status' as const };
    });

    if (r.kind === 'not_found') {
      throw new NotFoundException({
        code: 'ASSIGNMENT_NOT_FOUND',
        message: ASSIGNMENT_MESSAGES.assignmentNotFound,
      });
    }
    if (r.kind === 'not_driver') {
      throw new ForbiddenException({ code: 'NOT_THE_DRIVER', message: ASSIGNMENT_MESSAGES.notTheDriver });
    }
    if (r.kind === 'invalid_status') {
      throw new ConflictException({ code: 'INVALID_STATUS', message: ASSIGNMENT_MESSAGES.notAccepted });
    }

    this.clearTimer(assignmentId);
    this.chains.delete(r.tripRequestId);

    const ev: AssignmentCancelledByDriverEvent = {
      assignment_id: assignmentId,
      trip_request_id: r.tripRequestId,
      driver_id: driverId,
      reason: dto.reason,
      trip_request_status: r.status,
      occurred_at: new Date().toISOString(),
    };
    this.emitter.emit(ASSIGNMENT_EVENTS.ASSIGNMENT_CANCELLED_BY_DRIVER, ev);

    return {
      assignment_id: assignmentId,
      trip_request_id: r.tripRequestId,
      trip_request_status: r.status,
      searching_again: r.status === 'pending_assignment',
    };
  }

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_CANCELLED)
  async onTripRequestCancelled(ev: TripRequestCancelledEvent): Promise<void> {
    const ctx = this.chains.get(ev.trip_request_id);
    this.chains.delete(ev.trip_request_id);
    const offer = ctx?.currentOffer;
    if (!offer) return;
    this.clearTimer(offer.assignmentId);
    try {
      await this.prisma.runInTenant(offer.companyId, (tx) =>
        this.repo.cancelOffer(tx, offer.assignmentId, offer.companyId),
      );
    } catch (e) {
      this.logger.error(`Offer cancellation failed assignment=${offer.assignmentId}: ${summarizeError(e)}`);
    }
  }
}

function neighborhoodOf(address: string): string {
  const first = address.split(',')[0]?.trim();
  return first && first.length > 0 ? first : 'Zona destino';
}
