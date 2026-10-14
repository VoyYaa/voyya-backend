import { Logger, type LoggerService } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaClient } from '@prisma/client';
import {
  ANDROID_TRIP_UPDATES_CHANNEL_ID,
  ASSIGNMENT_EVENTS,
  PASSENGER_PUSH_NOTIFICATION_TYPES,
  type PassengerPushNotificationType,
} from '@voyyaa/shared';
import type { ExpoPushMessage } from 'expo-server-sdk';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  expectedPassengerPushMessage,
  leakedTerms,
  SEEDED_REASON,
  SEEDED_TTL_SEC,
  withoutLegitimateTripId,
} from '../src/modules/notifications/passenger/passenger-push.fixture';
import {
  type PushDelivery,
  type PushLogRef,
  type PushMessage,
  type PushTransport,
} from '../src/modules/notifications/ports/push-transport.port';
import { PushTokenRepository } from '../src/modules/notifications/push-token.repository';
import { RecordingPushTransport } from '../src/modules/notifications/recording-push-transport.fixture';
import { toExpoMessage } from '../src/modules/notifications/transport/expo-push.transport';
import {
  type DriverFixture,
  type World,
  bootWorld,
  createCoveredMunicipality,
  createDriver,
  createOffer,
  createOperatingCompany,
  createPendingTrip,
  driverAuth,
  ownerClient,
  tripRow,
} from './support/dispatch-world';
import { createFreshPassenger } from './support/fresh-passenger';
import { grantLocationConsent } from './support/grant-location-consent';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';
import { createAcceptedTrip, createEnRouteTrip } from './support/window-trip';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_PushPax';
const CENTER = { lat: 12.35, lng: -69.45 };
const NEAR = { lat: CENTER.lat + 0.001, lng: CENTER.lng };

const RICH = {
  passenger: { firstName: 'Valeria', lastName: 'Restrepo', phone: '3001234567' },
  driver: { firstName: 'Marcelo', lastName: 'Quintero', phone: '3105558899', nationalId: '1017224455' },
  vehicle: { plate: 'ZKQ-912', model: 'Chevrolet Spark amarillo' },
  company: { publicName: 'Transportes del Norte', legalName: 'Cootrayal Yarumal' },
  pickup: { address: 'Calle 50 # 30-20, Barrio El Prado', lat: 6.9647, lng: -75.4197 },
  dropoff: { address: 'Carrera 21, Barrio La Esperanza', lat: 6.9702, lng: -75.4301 },
  fare: 8000,
} as const;

const DRIVER_REASON = 'Se me dañó el carro';

const PERSONAL_VALUES_FOR_LOGS: readonly string[] = [
  'valeria',
  'restrepo',
  'marcelo',
  'quintero',
  '3001234567',
  '3105558899',
  '1017224455',
  'zkq-912',
  'chevrolet',
  'transportes del norte',
  'cootrayal',
  'calle 50',
  'el prado',
  'carrera 21',
  'la esperanza',
  '6.9647',
  '-75.4197',
  '6.9702',
  '-75.4301',
  SEEDED_REASON,
];

jest.setTimeout(120_000);

const settle = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class SwitchableTransport implements PushTransport {
  readonly recording = new RecordingPushTransport();
  real: PushTransport | null = null;
  failAudience: 'passenger' | 'driver' | null = null;

  async send(userId: number, message: PushMessage, ref: PushLogRef): Promise<PushDelivery> {
    if (this.failAudience === ref.audience) {
      this.recording.sent.push({ userId, message, ref });
      throw new Error(`push transport is down for ${ref.audience}`);
    }
    const recorded = await this.recording.send(userId, message, ref);
    return this.real ? this.real.send(userId, message, ref) : recorded;
  }

  reset(): void {
    this.recording.reset();
    this.failAudience = null;
  }
}

class TokenLookupTransport implements PushTransport {
  readonly handedToExpo: ExpoPushMessage[] = [];

  constructor(private readonly tokens: PushTokenRepository) {}

  async send(userId: number, message: PushMessage): Promise<PushDelivery> {
    const stored = await this.tokens.listByUser(userId);
    const messages = stored
      .filter((token) => /^ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]$/.test(token))
      .map((token) => toExpoMessage(token, message));
    this.handedToExpo.push(...messages);
    if (messages.length === 0) return { outcome: 'no_token' };
    return { outcome: 'sent', tokens: messages.length, ok: messages.length, failed: 0 };
  }
}

class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  log(message: unknown): void {
    this.lines.push(String(message));
  }
  warn(message: unknown): void {
    this.lines.push(String(message));
  }
  error(message: unknown): void {
    this.lines.push(String(message));
  }
  debug(message: unknown): void {
    this.lines.push(String(message));
  }
  verbose(message: unknown): void {
    this.lines.push(String(message));
  }
  fatal(message: unknown): void {
    this.lines.push(String(message));
  }
}

suite('Passenger push on the real app: events leave the transitions and reach PUSH_TRANSPORT (ADR-034 sections 2, 3 and 9)', () => {
  const switchable = new SwitchableTransport();
  const transport = switchable.recording;
  let lookup: TokenLookupTransport;
  const fakeExpo = {
    get sent(): ExpoPushMessage[] {
      return lookup.handedToExpo;
    },
    reset(): void {
      lookup.handedToExpo.length = 0;
    },
  };
  const logs = new CapturingLogger();
  let world: World;
  let owner: PrismaClient | null;
  let http: ReturnType<typeof request>;
  let municipalityId: number;
  let companyId: number;
  let richMunicipalityId: number;
  let richCompanyId: number;

  const post = (path: string, driverId: number, body: object = {}, forCompany: number = companyId) =>
    http.post(path).set('Authorization', driverAuth(world.jwt, driverId, forCompany)).send(body);

  const types = (): string[] => transport.sent.map((record) => record.message.data.type);

  const exhausted = (tripRequestId: number) => ({
    trip_request_id: tripRequestId,
    attempts_made: 3,
    final_radius_km: 5,
    occurred_at: new Date().toISOString(),
  });

  async function emitExhausted(tripRequestId: number): Promise<void> {
    await world.moduleRef
      .get(EventEmitter2)
      .emitAsync(ASSIGNMENT_EVENTS.SEARCH_EXHAUSTED, exhausted(tripRequestId))
      .catch(() => undefined);
  }

  async function withFailingWrite<T>(
    table: 'trips.trip_request' | 'assignment.assignment',
    condition: string,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!owner) throw new Error('PG_TEST_OWNER_URL is required for the failing-write scenarios');
    const trigger = `_pp_poison_${randomUUID().replace(/-/g, '')}`;
    await owner.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION public._pp_poison_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'e2e poisoned write'; END $$`,
    );
    await owner.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} AFTER UPDATE ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION public._pp_poison_write()`,
    );
    try {
      return await run();
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    }
  }

  const tripIs = (tripRequestId: number): string => `NEW.trip_request_id = ${Number(tripRequestId)}`;

  async function driverStatusOf(driver: DriverFixture): Promise<string> {
    const row = await world.prisma.runInTenant(companyId, (tx) =>
      tx.driver.findFirst({ where: { driverId: driver.driverId } }),
    );
    return row?.status ?? 'MISSING';
  }

  async function isolateDriver(keep: DriverFixture): Promise<void> {
    await world.prisma.runInTenant(companyId, (tx) =>
      tx.$executeRaw`UPDATE fleet.driver SET status = 'off_shift' WHERE status = 'available' AND driver_id <> ${keep.driverId}`,
    );
  }

  async function retireRichPassenger(): Promise<void> {
    await world.prisma.user.updateMany({
      where: { phone: RICH.passenger.phone },
      data: { phone: `_retired-${randomUUID()}` },
    });
  }

  async function richPassenger(): Promise<number> {
    await retireRichPassenger();
    const passengerId = await createFreshPassenger(world.prisma, {
      firstName: RICH.passenger.firstName,
      lastName: RICH.passenger.lastName,
    });
    await world.prisma.user.update({ where: { userId: passengerId }, data: { phone: RICH.passenger.phone } });
    return passengerId;
  }

  async function richDriver(position: { lat: number; lng: number }): Promise<DriverFixture> {
    await world.prisma.user.updateMany({
      where: { phone: RICH.driver.phone },
      data: { phone: `_retired-${randomUUID()}` },
    });
    await world.prisma.runInTenant(richCompanyId, async (tx) => {
      await tx.vehicle.updateMany({
        where: { plate: RICH.vehicle.plate },
        data: { plate: `_retired-${randomUUID()}` },
      });
      await tx.driver.updateMany({
        where: { nationalId: RICH.driver.nationalId },
        data: { nationalId: `_retired-${randomUUID()}` },
      });
    });
    const driver = await createDriver(world.prisma, richCompanyId, position);
    await grantLocationConsent(world.prisma, driver.driverId);
    await world.prisma.user.update({
      where: { userId: driver.driverId },
      data: {
        firstName: RICH.driver.firstName,
        lastName: RICH.driver.lastName,
        phone: RICH.driver.phone,
      },
    });
    await world.prisma.runInTenant(richCompanyId, async (tx) => {
      await tx.vehicle.update({
        where: { vehicleId: driver.vehicleId },
        data: { plate: RICH.vehicle.plate, model: RICH.vehicle.model },
      });
      await tx.driver.update({
        where: { driverId: driver.driverId },
        data: { nationalId: RICH.driver.nationalId },
      });
    });
    return driver;
  }

  async function richPendingTrip(passengerId: number) {
    const trip = await createPendingTrip(
      world.prisma,
      richMunicipalityId,
      { lat: RICH.pickup.lat, lng: RICH.pickup.lng },
      { passengerId, fare: RICH.fare },
    );
    await world.prisma.tripRequest.update({
      where: { tripRequestId: trip.tripRequestId },
      data: {
        pickupAddress: RICH.pickup.address,
        pickupLat: RICH.pickup.lat,
        pickupLng: RICH.pickup.lng,
        dropoffAddress: RICH.dropoff.address,
        dropoffLat: RICH.dropoff.lat,
        dropoffLng: RICH.dropoff.lng,
      },
    });
    return trip;
  }

  const FAR_ENOUGH = { lat: RICH.pickup.lat + 0.00315, lng: RICH.pickup.lng };

  async function registerPassengerToken(passengerId: number): Promise<string> {
    const token = `ExponentPushToken[pax-${randomUUID()}]`;
    await world.prisma.pushToken.create({ data: { userId: passengerId, token, platform: 'android' } });
    return token;
  }

  async function currentStartCode(tripRequestId: number): Promise<string | null> {
    const rows = await world.prisma.$queryRaw<Array<{ start_code: string | null }>>`
      SELECT start_code FROM trips.trip_request WHERE trip_request_id = ${tripRequestId}`;
    return rows[0]?.start_code ?? null;
  }

  async function expectCleanPush(
    message: PushMessage,
    tripRequestId: number,
    type: PassengerPushNotificationType,
    seenCodes: Array<string | null> = [],
  ): Promise<void> {
    expect(Object.keys(message).sort()).toEqual(
      ['body', 'channelId', 'data', 'priority', 'replaceKey', 'sound', 'title', 'ttlSec'].sort(),
    );
    expect(Object.keys(message.data).sort()).toEqual(['trip_request_id', 'type']);
    expect(message).toStrictEqual(expectedPassengerPushMessage(type, tripRequestId));
    const serialized = JSON.stringify(message);
    expect(leakedTerms(serialized, tripRequestId)).toEqual([]);
    const codes = [...seenCodes, await currentStartCode(tripRequestId)].filter(
      (code): code is string => code !== null,
    );
    for (const code of codes) expect(withoutLegitimateTripId(serialized, tripRequestId)).not.toContain(code);
  }

  function expectCleanExpoMessages(
    messages: ExpoPushMessage[],
    tripRequestId: number,
    passengerToken: string,
    type: PassengerPushNotificationType,
  ): void {
    expect(messages).toHaveLength(1);
    const [only] = messages;
    expect(Object.keys(only ?? {}).sort()).toEqual(
      ['body', 'channelId', 'collapseId', 'data', 'priority', 'sound', 'tag', 'title', 'to', 'ttl'].sort(),
    );
    expect(only).toStrictEqual({
      to: passengerToken,
      title: expectedPassengerPushMessage(type, tripRequestId).title,
      body: expectedPassengerPushMessage(type, tripRequestId).body,
      data: { type, trip_request_id: tripRequestId },
      sound: 'default',
      priority: 'high',
      channelId: ANDROID_TRIP_UPDATES_CHANNEL_ID,
      ttl: SEEDED_TTL_SEC,
      tag: `trip-${tripRequestId}`,
      collapseId: `trip-${tripRequestId}`,
    });
    const serialized = JSON.stringify(only).replace(passengerToken, '');
    expect(leakedTerms(serialized, tripRequestId)).toEqual([]);
  }

  function personalValuesInLogs(): string[] {
    const haystack = logs.lines.join('\n').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    return PERSONAL_VALUES_FOR_LOGS.filter((term) => haystack.includes(term.toLowerCase()));
  }

  beforeAll(async () => {
    world = await bootWorld({ pushTransport: switchable });
    Logger.overrideLogger(logs);
    owner = ownerClient();
    http = request(world.app.getHttpServer());
    municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, CENTER);
    companyId = await createOperatingCompany(world.prisma, municipalityId, { commissionPct: 8 });
    richMunicipalityId = await createCoveredMunicipality(world.prisma, PREFIX, {
      lat: RICH.pickup.lat,
      lng: RICH.pickup.lng,
    });
    richCompanyId = await createOperatingCompany(world.prisma, richMunicipalityId, {
      commissionPct: 8,
      publicName: RICH.company.publicName,
    });
    await world.prisma.company.update({
      where: { companyId: richCompanyId },
      data: { legalName: RICH.company.legalName },
    });
    lookup = new TokenLookupTransport(world.moduleRef.get(PushTokenRepository, { strict: false }));
    switchable.real = lookup;
  });

  afterAll(async () => {
    if (world) {
      await retireRichPassenger();
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
    await owner?.$disconnect();
  });

  beforeEach(() => {
    switchable.reset();
    fakeExpo.reset();
    logs.lines.length = 0;
  });

  describe('the five facts reach the transport after the commit, only when applied (T-2, T-3, T-5)', () => {
    it('E1: the driver accepting sends trip_driver_assigned to the passenger owner and to nobody else', async () => {
      const trip = await createAcceptedTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();

      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.userId).toBe(trip.passengerId);
      expect(transport.sent[0]?.message).toEqual(
        expectedPassengerPushMessage('trip_driver_assigned', trip.tripRequestId),
      );
      expect(leakedTerms(JSON.stringify(transport.sent[0]?.message), trip.tripRequestId)).toEqual([]);
    });

    it('E3: marking arrival sends trip_driver_arrived once; the second tap (idempotent) sends nothing', async () => {
      const trip = await createEnRouteTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();

      const first = await post(`/trips/${trip.tripRequestId}/arrived`, trip.driver.driverId);
      const second = await post(`/trips/${trip.tripRequestId}/arrived`, trip.driver.driverId);
      await settle();

      expect(first.status).toBe(200);
      expect(first.body.idempotent).toBe(false);
      expect(second.body.idempotent).toBe(true);
      expect(types()).toEqual(['trip_driver_arrived']);
      expect(transport.sent[0]?.userId).toBe(trip.passengerId);
      expect(transport.sent[0]?.message).toEqual(
        expectedPassengerPushMessage('trip_driver_arrived', trip.tripRequestId),
      );
    });

    it('E2a then E1: a driver cancelling from assigned reopens the search, and the next acceptance is "new driver" with the same replace key', async () => {
      const first = await createAcceptedTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();

      const cancelled = await post(`/assignments/${first.assignmentId}/cancel`, first.driver.driverId, {
        reason: SEEDED_REASON,
      });
      await settle();
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.searching_again).toBe(true);

      const second = await createDriver(world.prisma, companyId, NEAR);
      await grantLocationConsent(world.prisma, second.driverId);
      const offerId = await createOffer(world.prisma, first.tripRequestId, second, companyId);
      const accepted = await post(`/assignments/${offerId}/accept`, second.driverId);
      await settle();

      expect(accepted.body.result).toBe('accepted');
      expect(types()).toEqual(['trip_driver_cancelled_searching', 'trip_driver_reassigned']);
      expect(transport.sent.map((record) => record.userId)).toEqual([first.passengerId, first.passengerId]);
      expect(transport.sent[0]?.message.replaceKey).toBe(`trip-${first.tripRequestId}`);
      expect(transport.sent[1]?.message.replaceKey).toBe(`trip-${first.tripRequestId}`);
      expect(JSON.stringify(transport.sent)).not.toContain(SEEDED_REASON);
    });

    it('E2b: a driver cancelling once on the way ends the trip and sends trip_driver_cancelled_ended; repeating it sends nothing', async () => {
      const trip = await createEnRouteTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();

      const cancelled = await post(`/assignments/${trip.assignmentId}/cancel`, trip.driver.driverId, {
        reason: SEEDED_REASON,
      });
      const repeated = await post(`/assignments/${trip.assignmentId}/cancel`, trip.driver.driverId, {
        reason: SEEDED_REASON,
      });
      await settle();

      expect(cancelled.status).toBe(200);
      expect(cancelled.body.trip_request_status).toBe('cancelled_by_driver');
      expect(repeated.status).toBe(409);
      expect(types()).toEqual(['trip_driver_cancelled_ended']);
      expect(JSON.stringify(transport.sent)).not.toContain(SEEDED_REASON);
    });

    it('E4: an exhausted search applied by trips sends trip_no_driver; one that trips ignores sends nothing', async () => {
      const pending = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const emitter = world.moduleRef.get(EventEmitter2);

      await emitter.emitAsync(ASSIGNMENT_EVENTS.SEARCH_EXHAUSTED, exhausted(pending.tripRequestId));
      await settle();

      expect((await tripRow(world.prisma, pending.tripRequestId)).status).toBe('no_driver');
      expect(types()).toEqual(['trip_no_driver']);
      expect(transport.sent[0]?.userId).toBe(pending.passengerId);

      transport.reset();
      const taken = await createAcceptedTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();

      await emitter.emitAsync(ASSIGNMENT_EVENTS.SEARCH_EXHAUSTED, exhausted(taken.tripRequestId));
      await settle();

      expect((await tripRow(world.prisma, taken.tripRequestId)).status).toBe('assigned');
      expect(transport.sent).toEqual([]);
    });

    it.each(['reject', 'hang'] as const)(
      'a transport that does %s changes nothing: the transition is applied and the driver gets the usual response in time',
      async (mode) => {
        transport.mode = mode;
        const driver = await createDriver(world.prisma, companyId, NEAR);
        const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
        const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyId);

        const start = Date.now();
        const response = await post(`/assignments/${offerId}/accept`, driver.driverId);
        const elapsed = Date.now() - start;
        await settle();

        expect(response.status).toBe(200);
        expect(response.body.result).toBe('accepted');
        expect(elapsed).toBeLessThan(5_000);
        expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('assigned');
        expect(transport.sent).toHaveLength(1);
      },
    );

    it('a take that is lost sends nothing to the passenger', async () => {
      const trip = await createAcceptedTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();
      const late = await createDriver(world.prisma, companyId, NEAR);
      const lateOffer = await createOffer(world.prisma, trip.tripRequestId, late, companyId);

      const response = await post(`/assignments/${lateOffer}/accept`, late.driverId);
      await settle();

      expect(response.body.result).toBe('already_taken');
      expect(transport.sent).toEqual([]);
    });

    it('a transport that rejects on E3, E2b and E4 leaves each transition applied and the answer to the driver intact', async () => {
      const arriving = await createEnRouteTrip(world, { municipalityId, companyId, pickup: CENTER });
      const ending = await createEnRouteTrip(world, { municipalityId, companyId, pickup: CENTER });
      const searching = await createPendingTrip(world.prisma, municipalityId, CENTER);
      await settle();
      switchable.reset();
      switchable.failAudience = 'passenger';

      const arrived = await post(`/trips/${arriving.tripRequestId}/arrived`, arriving.driver.driverId);
      const cancelled = await post(`/assignments/${ending.assignmentId}/cancel`, ending.driver.driverId, {
        reason: DRIVER_REASON,
      });
      await emitExhausted(searching.tripRequestId);
      await settle();

      expect(arrived.status).toBe(200);
      expect(arrived.body.idempotent).toBe(false);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.trip_request_status).toBe('cancelled_by_driver');
      expect((await tripRow(world.prisma, searching.tripRequestId)).status).toBe('no_driver');
      expect(types().sort()).toEqual(
        ['trip_driver_arrived', 'trip_driver_cancelled_ended', 'trip_no_driver'].sort(),
      );
    });

    it('requests the transition cannot apply send nothing: arriving from assigned, a stranger cancelling, a driver of another company', async () => {
      const assigned = await createAcceptedTrip(world, { municipalityId, companyId, pickup: CENTER });
      const stranger = await createDriver(world.prisma, companyId, NEAR);
      await settle();
      transport.reset();

      const arrivedTooEarly = await post(`/trips/${assigned.tripRequestId}/arrived`, assigned.driver.driverId);
      const cancelledByStranger = await post(`/assignments/${assigned.assignmentId}/cancel`, stranger.driverId, {
        reason: DRIVER_REASON,
      });
      const cancelledAsOtherCompany = await post(
        `/assignments/${assigned.assignmentId}/cancel`,
        assigned.driver.driverId,
        { reason: DRIVER_REASON },
        companyId + 100_000,
      );
      await settle();

      expect(arrivedTooEarly.status).toBe(409);
      expect(cancelledByStranger.status).toBe(403);
      expect([403, 404]).toContain(cancelledAsOtherCompany.status);
      expect(transport.sent).toEqual([]);
      expect((await tripRow(world.prisma, assigned.tripRequestId)).status).toBe('assigned');
    });
  });

  describe('a transaction that rolls back sends nothing and a later retry does (T-2)', () => {
    it('E1: a take that fails after the trip was already updated rolls everything back, sends nothing, and the retry sends once', async () => {
      const driver = await createDriver(world.prisma, companyId, NEAR);
      await grantLocationConsent(world.prisma, driver.driverId);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyId);

      const failed = await withFailingWrite(
        'assignment.assignment',
        `${tripIs(trip.tripRequestId)} AND NEW.status = 'accepted'`,
        () => post(`/assignments/${offerId}/accept`, driver.driverId),
      );
      await settle();

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(transport.sent).toEqual([]);
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('pending_assignment');
      expect(await driverStatusOf(driver)).toBe('available');

      const retried = await post(`/assignments/${offerId}/accept`, driver.driverId);
      await settle();
      expect(retried.body.result).toBe('accepted');
      expect(types()).toEqual(['trip_driver_assigned']);
    });

    it('E3: an arrival that fails inside the transaction sends nothing and arrived_at stays null; the retry sends once', async () => {
      const trip = await createEnRouteTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();

      const failed = await withFailingWrite(
        'trips.trip_request',
        `${tripIs(trip.tripRequestId)} AND NEW.arrived_at IS NOT NULL`,
        () => post(`/trips/${trip.tripRequestId}/arrived`, trip.driver.driverId),
      );
      await settle();

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(transport.sent).toEqual([]);
      expect((await tripRow(world.prisma, trip.tripRequestId)).arrivedAt).toBeNull();

      const retried = await post(`/trips/${trip.tripRequestId}/arrived`, trip.driver.driverId);
      await settle();
      expect(retried.body.idempotent).toBe(false);
      expect(types()).toEqual(['trip_driver_arrived']);
    });

    it('E2a and E2b: a cancellation that fails after reopening or closing the trip rolls back and sends nothing', async () => {
      const assigned = await createAcceptedTrip(world, { municipalityId, companyId, pickup: CENTER });
      const enRoute = await createEnRouteTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();

      const searchingFailed = await withFailingWrite(
        'assignment.assignment',
        `${tripIs(assigned.tripRequestId)} AND NEW.status = 'cancelled'`,
        () =>
          post(`/assignments/${assigned.assignmentId}/cancel`, assigned.driver.driverId, {
            reason: DRIVER_REASON,
          }),
      );
      const endedFailed = await withFailingWrite(
        'trips.trip_request',
        `${tripIs(enRoute.tripRequestId)} AND NEW.status = 'cancelled_by_driver'`,
        () =>
          post(`/assignments/${enRoute.assignmentId}/cancel`, enRoute.driver.driverId, {
            reason: DRIVER_REASON,
          }),
      );
      await settle();

      expect(searchingFailed.status).toBeGreaterThanOrEqual(500);
      expect(endedFailed.status).toBeGreaterThanOrEqual(500);
      expect(transport.sent).toEqual([]);
      expect((await tripRow(world.prisma, assigned.tripRequestId)).status).toBe('assigned');
      expect((await tripRow(world.prisma, enRoute.tripRequestId)).status).toBe('driver_en_route');
    });

    it('E4: a no-driver update that fails sends nothing and the trip stays pending', async () => {
      const pending = await createPendingTrip(world.prisma, municipalityId, CENTER);

      await withFailingWrite(
        'trips.trip_request',
        `${tripIs(pending.tripRequestId)} AND NEW.status = 'no_driver'`,
        () => emitExhausted(pending.tripRequestId),
      );
      await settle();

      expect(transport.sent).toEqual([]);
      expect((await tripRow(world.prisma, pending.tripRequestId)).status).toBe('pending_assignment');
    });
  });

  describe('T-1a: the message is the closed list, on a trip seeded with every forbidden kind of data', () => {
    async function seededScenario() {
      const passengerId = await richPassenger();
      const token = await registerPassengerToken(passengerId);
      return { passengerId, token };
    }

    async function acceptRich(tripRequestId: number, driver: DriverFixture) {
      const offerId = await createOffer(world.prisma, tripRequestId, driver, richCompanyId);
      const response = await post(`/assignments/${offerId}/accept`, driver.driverId, {}, richCompanyId);
      expect(response.body.result).toBe('accepted');
      return offerId;
    }

    it('E1 trip_driver_assigned: the rich trip is really seeded and none of it leaves in the message', async () => {
      const { passengerId, token } = await seededScenario();
      const trip = await richPendingTrip(passengerId);
      const driver = await richDriver(FAR_ENOUGH);

      const seeded = await world.prisma.tripRequest.findUniqueOrThrow({
        where: { tripRequestId: trip.tripRequestId },
      });
      expect(seeded.pickupAddress).toContain('El Prado');
      expect(seeded.dropoffAddress).toContain('La Esperanza');
      expect(Number(seeded.fare)).toBe(8000);

      await acceptRich(trip.tripRequestId, driver);
      await settle();

      const code = await currentStartCode(trip.tripRequestId);
      expect(code).toMatch(/^\d{4}$/);
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.userId).toBe(passengerId);
      await expectCleanPush(transport.sent[0]!.message, trip.tripRequestId, 'trip_driver_assigned', [code]);
      expectCleanExpoMessages(fakeExpo.sent, trip.tripRequestId, token, 'trip_driver_assigned');
      expect(personalValuesInLogs()).toEqual([]);
    });

    it('E3 trip_driver_arrived: the arrival of a driver with a name, a plate and a phone says none of them', async () => {
      const { passengerId, token } = await seededScenario();
      const trip = await richPendingTrip(passengerId);
      const driver = await richDriver(FAR_ENOUGH);
      await acceptRich(trip.tripRequestId, driver);
      await post(`/trips/${trip.tripRequestId}/en-route`, driver.driverId, {}, richCompanyId);
      expect(await currentStartCode(trip.tripRequestId)).toMatch(/^\d{4}$/);
      await settle();
      switchable.reset();
      fakeExpo.reset();

      const arrived = await post(`/trips/${trip.tripRequestId}/arrived`, driver.driverId, {}, richCompanyId);
      await settle();

      expect(arrived.status).toBe(200);
      expect(types()).toEqual(['trip_driver_arrived']);
      await expectCleanPush(transport.sent[0]!.message, trip.tripRequestId, 'trip_driver_arrived');
      expectCleanExpoMessages(fakeExpo.sent, trip.tripRequestId, token, 'trip_driver_arrived');
      expect(personalValuesInLogs()).toEqual([]);
    });

    it('E2a and E1 reassigned: the cancellation reason sentinel never leaves, and the new driver is anonymous too', async () => {
      const { passengerId } = await seededScenario();
      const trip = await richPendingTrip(passengerId);
      const first = await richDriver(FAR_ENOUGH);
      const firstOffer = await acceptRich(trip.tripRequestId, first);
      const firstCode = await currentStartCode(trip.tripRequestId);
      expect(firstCode).toMatch(/^\d{4}$/);
      await settle();
      switchable.reset();
      fakeExpo.reset();

      const cancelled = await post(
        `/assignments/${firstOffer}/cancel`,
        first.driverId,
        { reason: SEEDED_REASON },
        richCompanyId,
      );
      expect(cancelled.body.searching_again).toBe(true);
      const second = await richDriver(FAR_ENOUGH);
      await acceptRich(trip.tripRequestId, second);
      await settle();

      expect(types()).toEqual(['trip_driver_cancelled_searching', 'trip_driver_reassigned']);
      const secondCode = await currentStartCode(trip.tripRequestId);
      expect(secondCode).toMatch(/^\d{4}$/);
      expect(secondCode).not.toBe(firstCode);
      await expectCleanPush(transport.sent[0]!.message, trip.tripRequestId, 'trip_driver_cancelled_searching', [
        firstCode,
        secondCode,
      ]);
      await expectCleanPush(transport.sent[1]!.message, trip.tripRequestId, 'trip_driver_reassigned', [
        firstCode,
        secondCode,
      ]);
      expect(JSON.stringify(fakeExpo.sent)).not.toContain(SEEDED_REASON);
      expect(fakeExpo.sent).toHaveLength(2);
      expect(fakeExpo.sent.every((message) => message.tag === `trip-${trip.tripRequestId}`)).toBe(true);
      expect(personalValuesInLogs()).toEqual([]);
    });

    it('E2b trip_driver_cancelled_ended: a reason written by the driver on the way does not leave', async () => {
      const { passengerId, token } = await seededScenario();
      const trip = await richPendingTrip(passengerId);
      const driver = await richDriver(FAR_ENOUGH);
      const offer = await acceptRich(trip.tripRequestId, driver);
      await post(`/trips/${trip.tripRequestId}/en-route`, driver.driverId, {}, richCompanyId);
      const codeBefore = await currentStartCode(trip.tripRequestId);
      expect(codeBefore).toMatch(/^\d{4}$/);
      await settle();
      switchable.reset();
      fakeExpo.reset();

      const cancelled = await post(
        `/assignments/${offer}/cancel`,
        driver.driverId,
        { reason: SEEDED_REASON },
        richCompanyId,
      );
      await settle();

      expect(cancelled.body.trip_request_status).toBe('cancelled_by_driver');
      expect(types()).toEqual(['trip_driver_cancelled_ended']);
      await expectCleanPush(transport.sent[0]!.message, trip.tripRequestId, 'trip_driver_cancelled_ended', [
        codeBefore,
      ]);
      expectCleanExpoMessages(fakeExpo.sent, trip.tripRequestId, token, 'trip_driver_cancelled_ended');
      expect(personalValuesInLogs()).toEqual([]);
    });

    it('E4 trip_no_driver: a search that ends without a driver names no company, no address and no attempt count', async () => {
      const { passengerId, token } = await seededScenario();
      const trip = await richPendingTrip(passengerId);

      await emitExhausted(trip.tripRequestId);
      await settle();

      expect(types()).toEqual(['trip_no_driver']);
      await expectCleanPush(transport.sent[0]!.message, trip.tripRequestId, 'trip_no_driver');
      expectCleanExpoMessages(fakeExpo.sent, trip.tripRequestId, token, 'trip_no_driver');
      expect(personalValuesInLogs()).toEqual([]);
    });

    it('the closed forbidden list catches every value seeded in the rich trip, so the net has no holes', () => {
      const seeded: Array<string | number> = [
        RICH.passenger.firstName,
        RICH.passenger.lastName,
        RICH.passenger.phone,
        RICH.driver.firstName,
        RICH.driver.lastName,
        RICH.driver.phone,
        RICH.driver.nationalId,
        RICH.vehicle.plate,
        RICH.vehicle.model,
        RICH.company.publicName,
        RICH.company.legalName,
        RICH.pickup.address,
        RICH.pickup.lat,
        RICH.pickup.lng,
        RICH.dropoff.address,
        RICH.dropoff.lat,
        RICH.dropoff.lng,
        RICH.fare,
        SEEDED_REASON,
        '4821',
      ];

      for (const value of seeded) {
        expect({ value, leaks: leakedTerms(`prefix ${value} suffix`).length > 0 }).toEqual({ value, leaks: true });
      }
    });

    it('the six types are exactly the ones in the contract and each has its own copy', () => {
      expect([...PASSENGER_PUSH_NOTIFICATION_TYPES].sort()).toEqual(
        [
          'trip_driver_arrived',
          'trip_driver_assigned',
          'trip_driver_cancelled_ended',
          'trip_driver_cancelled_searching',
          'trip_driver_reassigned',
          'trip_no_driver',
        ].sort(),
      );
    });
  });

  describe('T-4: simultaneous acceptances produce one notice', () => {
    it.each([2, 6])('%i drivers accepting the same trip at once: one wins, one notice, to the passenger owner', async (count) => {
      for (let round = 0; round < 4; round += 1) {
        switchable.reset();
        const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
        const drivers: DriverFixture[] = [];
        const offers: number[] = [];
        for (let index = 0; index < count; index += 1) {
          const driver = await createDriver(world.prisma, companyId, NEAR);
          await grantLocationConsent(world.prisma, driver.driverId);
          drivers.push(driver);
          offers.push(await createOffer(world.prisma, trip.tripRequestId, driver, companyId));
        }

        const responses = await Promise.all(
          drivers.map((driver, index) => post(`/assignments/${offers[index]}/accept`, driver.driverId)),
        );
        await settle(150);

        const results = responses.map((response) => response.body.result as string);
        expect(results.filter((result) => result === 'accepted')).toHaveLength(1);
        expect(results.filter((result) => result === 'already_taken')).toHaveLength(count - 1);
        expect(types()).toEqual(['trip_driver_assigned']);
        expect(transport.sent[0]?.userId).toBe(trip.passengerId);
        expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('assigned');
      }
    });

    it('the same offer accepted twice at once (a network retry) sends one notice', async () => {
      const driver = await createDriver(world.prisma, companyId, NEAR);
      await grantLocationConsent(world.prisma, driver.driverId);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyId);

      const responses = await Promise.all([
        post(`/assignments/${offerId}/accept`, driver.driverId),
        post(`/assignments/${offerId}/accept`, driver.driverId),
        post(`/assignments/${offerId}/accept`, driver.driverId),
      ]);
      await settle(150);

      expect(responses.filter((response) => response.body.result === 'accepted')).toHaveLength(1);
      expect(types()).toEqual(['trip_driver_assigned']);
    });

    it('a double tap on "arrived" at the same instant sends one notice', async () => {
      const trip = await createEnRouteTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();

      const responses = await Promise.all([
        post(`/trips/${trip.tripRequestId}/arrived`, trip.driver.driverId),
        post(`/trips/${trip.tripRequestId}/arrived`, trip.driver.driverId),
        post(`/trips/${trip.tripRequestId}/arrived`, trip.driver.driverId),
      ]);
      await settle(150);

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(responses.filter((response) => response.body.idempotent === false)).toHaveLength(1);
      expect(types()).toEqual(['trip_driver_arrived']);
    });
  });

  describe('T-7: "Cualquiera" taken by company B notifies only the owner passenger, through the real token lookup', () => {
    it('every user of both companies has a token and only the passenger receives the message', async () => {
      const municipality = await createCoveredMunicipality(world.prisma, PREFIX, {
        lat: 12.75,
        lng: -69.05,
      });
      const companyA = await createOperatingCompany(world.prisma, municipality, { publicName: 'Alfa Taxis' });
      const companyB = await createOperatingCompany(world.prisma, municipality, { publicName: 'Beta Taxis' });
      const here = { lat: 12.75, lng: -69.05 };
      const driverA = await createDriver(world.prisma, companyA, here);
      const driverB = await createDriver(world.prisma, companyB, here);
      const adminA = await world.prisma.user.create({
        data: { firstName: '_Fx', lastName: 'AdminA', phone: `_fxa-${randomUUID()}`, role: 'admin', companyId: companyA },
      });
      const operatorB = await world.prisma.user.create({
        data: { firstName: '_Fx', lastName: 'OpB', phone: `_fxo-${randomUUID()}`, role: 'operator', companyId: companyB },
      });
      const bystander = await createFreshPassenger(world.prisma);
      await grantLocationConsent(world.prisma, driverB.driverId);
      const trip = await createPendingTrip(world.prisma, municipality, here, { requestedCompanyId: null });
      const tokens = new Map<number, string>();
      for (const userId of [
        trip.passengerId,
        driverA.driverId,
        driverB.driverId,
        adminA.userId,
        operatorB.userId,
        bystander,
      ]) {
        const token = `ExponentPushToken[t7-${randomUUID()}]`;
        await world.prisma.pushToken.create({ data: { userId, token, platform: 'android' } });
        tokens.set(userId, token);
      }
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driverB, companyB);

      const accepted = await post(`/assignments/${offerId}/accept`, driverB.driverId, {}, companyB);
      await settle(150);

      expect(accepted.body.result).toBe('accepted');
      expect((await tripRow(world.prisma, trip.tripRequestId)).companyId).toBe(companyB);
      expect(transport.sent.map((record) => record.userId)).toEqual([trip.passengerId]);
      expect(fakeExpo.sent).toHaveLength(1);
      expect(fakeExpo.sent[0]?.to).toBe(tokens.get(trip.passengerId));
      const foreignTokens = [...tokens.entries()]
        .filter(([userId]) => userId !== trip.passengerId)
        .map(([, token]) => token);
      for (const token of foreignTokens) expect(JSON.stringify(fakeExpo.sent)).not.toContain(token);
      expect(JSON.stringify(fakeExpo.sent)).not.toContain('Alfa');
      expect(JSON.stringify(fakeExpo.sent)).not.toContain('Beta');
    });
  });

  describe('T-3, T-5, T-6: order, isolation between audiences, and the cap, with the real chain', () => {
    it('E2a followed at once by E4 reach the transport in order even when the first send is slow', async () => {
      const first = await createAcceptedTrip(world, { municipalityId, companyId, pickup: CENTER });
      await settle();
      transport.reset();
      transport.beforeSend = async (index) => {
        if (index === 0) await settle(400);
      };

      await post(`/assignments/${first.assignmentId}/cancel`, first.driver.driverId, { reason: DRIVER_REASON });
      await emitExhausted(first.tripRequestId);
      await settle(150);

      expect(types()).toEqual(['trip_driver_cancelled_searching']);

      await settle(600);
      expect(types()).toEqual(['trip_driver_cancelled_searching', 'trip_no_driver']);
      expect(transport.sent.every((record) => record.message.replaceKey === `trip-${first.tripRequestId}`)).toBe(true);
    });

    it('with the passenger channel down the driver offer still goes out, and with the driver channel down the passenger notice still goes out', async () => {
      const driver = await createDriver(world.prisma, companyId, NEAR);
      await grantLocationConsent(world.prisma, driver.driverId);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      await isolateDriver(driver);
      switchable.failAudience = 'passenger';

      await world.assignment.onTripRequestCreated({
        trip_request_id: trip.tripRequestId,
        passenger_id: trip.passengerId,
        municipality_id: municipalityId,
        service_type: 'taxi',
        origin: CENTER,
        occurred_at: new Date().toISOString(),
      });
      await settle();
      const offered = transport.sent.filter((record) => record.ref.audience === 'driver');
      expect(offered.map((record) => record.userId)).toEqual([driver.driverId]);

      const offer = await world.prisma.runInTenant(companyId, (tx) =>
        tx.assignment.findFirstOrThrow({ where: { tripRequestId: trip.tripRequestId, status: 'notified' } }),
      );
      const accepted = await post(`/assignments/${offer.assignmentId}/accept`, driver.driverId);
      await settle();
      expect(accepted.body.result).toBe('accepted');
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('assigned');
      expect(transport.sent.some((record) => record.ref.audience === 'passenger')).toBe(true);

      switchable.reset();
      switchable.failAudience = 'driver';
      const second = await createDriver(world.prisma, companyId, NEAR);
      await grantLocationConsent(world.prisma, second.driverId);
      const other = await createPendingTrip(world.prisma, municipalityId, CENTER);
      await isolateDriver(second);
      await world.assignment.onTripRequestCreated({
        trip_request_id: other.tripRequestId,
        passenger_id: other.passengerId,
        municipality_id: municipalityId,
        service_type: 'taxi',
        origin: CENTER,
        occurred_at: new Date().toISOString(),
      });
      await settle();
      const secondOffer = await world.prisma.runInTenant(companyId, (tx) =>
        tx.assignment.findFirstOrThrow({ where: { tripRequestId: other.tripRequestId, status: 'notified' } }),
      );
      const secondAccepted = await post(`/assignments/${secondOffer.assignmentId}/accept`, second.driverId);
      await settle();
      expect(secondAccepted.body.result).toBe('accepted');
      expect(
        transport.sent.filter((record) => record.ref.audience === 'passenger').map((record) => record.userId),
      ).toEqual([other.passengerId]);
    });

    it('a loop of accepting and cancelling stops at ten notices for the trip while every transition still applies', async () => {
      const driver = await createDriver(world.prisma, companyId, NEAR);
      await grantLocationConsent(world.prisma, driver.driverId);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const statuses: number[] = [];

      for (let cycle = 0; cycle < 6; cycle += 1) {
        const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyId);
        const accepted = await post(`/assignments/${offerId}/accept`, driver.driverId);
        statuses.push(accepted.status);
        await settle(120);
        if (cycle < 5) {
          const cancelled = await post(`/assignments/${offerId}/cancel`, driver.driverId, {
            reason: DRIVER_REASON,
          });
          statuses.push(cancelled.status);
          await settle(120);
        }
      }

      expect(statuses.every((status) => status === 200)).toBe(true);
      expect(transport.sent).toHaveLength(10);
      expect(types()[9]).toBe('trip_driver_cancelled_searching');
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('assigned');
      expect(logs.lines.some((line) => line.includes(`capped tripRequest=${trip.tripRequestId} type=trip_driver_reassigned`))).toBe(true);
    });
  });

  describe('T-8: nothing a full flow logs carries personal data or the device token', () => {
    it('after the facts with seeded data the captured logs contain none of the personal values nor the token', async () => {
      const passengerId = await richPassenger();
      const token = await registerPassengerToken(passengerId);
      const trip = await richPendingTrip(passengerId);
      const driver = await richDriver(FAR_ENOUGH);
      const offer = await createOffer(world.prisma, trip.tripRequestId, driver, richCompanyId);
      await post(`/assignments/${offer}/accept`, driver.driverId, {}, richCompanyId);
      await post(`/trips/${trip.tripRequestId}/en-route`, driver.driverId, {}, richCompanyId);
      await post(`/trips/${trip.tripRequestId}/arrived`, driver.driverId, {}, richCompanyId);
      await post(`/assignments/${offer}/cancel`, driver.driverId, { reason: SEEDED_REASON }, richCompanyId);
      await settle(150);

      expect(fakeExpo.sent.length).toBeGreaterThan(0);
      expect(logs.lines.join('\n')).not.toContain(token);
      expect(personalValuesInLogs()).toEqual([]);
    });
  });
});
