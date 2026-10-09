import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient } from '@prisma/client';
import { addDays, settlementToday } from '@voyyaa/shared';
import request from 'supertest';
import { AssignmentRepository } from '../src/modules/assignment/assignment.repository';
import {
  type DriverFixture,
  type World,
  adminAuth,
  assignmentStatus,
  bootWorld,
  createAdminUser,
  createCoveredMunicipality,
  createDriver,
  createOffer,
  createOperatingCompany,
  createPendingTrip,
  driverAuth,
  driverStatus,
  offersOfTrip,
  ownerClient,
  passengerAuth,
  tripRow,
  waitForLockWaiters,
} from './support/dispatch-world';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';
import { startCodeOf } from './support/window-trip';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_McTake';
const CENTER = { lat: 12.05, lng: -69.85 };
const NEAR = { lat: CENTER.lat + 0.001, lng: CENTER.lng };

jest.setTimeout(90_000);

suite('Toma entre empresas, comisión y cancelación contra Postgres real como app_voyya (ADR-032 §2, §15.2)', () => {
  let world: World;
  let municipalityId: number;
  let companyA: number;
  let companyB: number;
  let companyC: number;
  let http: ReturnType<typeof request>;

  const COMMISSION_A = 8;
  const COMMISSION_B = 10.5;
  const COMMISSION_C = 12;

  const accept = (assignmentId: number, driver: DriverFixture, companyId: number) =>
    http
      .post(`/assignments/${assignmentId}/accept`)
      .set('Authorization', driverAuth(world.jwt, driver.driverId, companyId))
      .send({});

  async function twoOffers(options: { fare?: number } = {}) {
    const driverA = await createDriver(world.prisma, companyA, NEAR);
    const driverB = await createDriver(world.prisma, companyB, NEAR);
    const trip = await createPendingTrip(world.prisma, municipalityId, CENTER, { fare: options.fare });
    const offerA = await createOffer(world.prisma, trip.tripRequestId, driverA, companyA);
    const offerB = await createOffer(world.prisma, trip.tripRequestId, driverB, companyB);
    return { driverA, driverB, trip, offerA, offerB };
  }

  async function changeCommission(companyId: number, commissionPct: number): Promise<void> {
    await world.prisma.runAsPlatform(async (tx) => {
      await tx.$executeRaw`
        UPDATE tenancy.company_commission SET valid_to = (now() AT TIME ZONE 'UTC')
         WHERE company_id = ${companyId} AND valid_to IS NULL`;
      await tx.$executeRaw`
        INSERT INTO tenancy.company_commission (company_id, commission_pct, origin, valid_from)
        VALUES (${companyId}, ${commissionPct}, 'platform_edit', now() AT TIME ZONE 'UTC')`;
    });
  }

  beforeAll(async () => {
    world = await bootWorld();
    http = request(world.app.getHttpServer());
    municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, CENTER);
    companyA = await createOperatingCompany(world.prisma, municipalityId, {
      publicName: 'Alfa Taxis',
      commissionPct: COMMISSION_A,
    });
    companyB = await createOperatingCompany(world.prisma, municipalityId, {
      publicName: 'Beta Taxis',
      commissionPct: COMMISSION_B,
    });
    companyC = await createOperatingCompany(world.prisma, municipalityId, {
      publicName: 'Gamma Taxis',
      commissionPct: COMMISSION_C,
    });
  });

  afterAll(async () => {
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
  });

  describe('toma concurrente de dos empresas', () => {
    it('exactamente una gana, la perdedora recibe already_taken (nunca un 500) y el viaje queda con la empresa y la comisión de la ganadora', async () => {
      const rounds = 8;
      for (let round = 0; round < rounds; round += 1) {
        const { driverA, driverB, trip, offerA, offerB } = await twoOffers({ fare: 8750 });

        const [fromA, fromB] = await Promise.all([
          accept(offerA, driverA, companyA),
          accept(offerB, driverB, companyB),
        ]);

        const responses = [fromA, fromB];
        for (const response of responses) {
          expect(response.status).toBeLessThan(500);
        }
        const winners = responses.filter((response) => response.body.result === 'accepted');
        const losers = responses.filter((response) => response.body.result === 'already_taken');
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(winners[0]?.status).toBe(200);
        expect(losers[0]?.status).toBe(409);

        const winnerCompany = fromA.body.result === 'accepted' ? companyA : companyB;
        const loserCompany = winnerCompany === companyA ? companyB : companyA;
        const winnerDriver = winnerCompany === companyA ? driverA : driverB;
        const loserDriver = winnerCompany === companyA ? driverB : driverA;
        const pct = winnerCompany === companyA ? COMMISSION_A : COMMISSION_B;

        const row = await tripRow(world.prisma, trip.tripRequestId);
        expect(row.status).toBe('assigned');
        expect(row.companyId).toBe(winnerCompany);
        expect(Number(row.commissionPct)).toBe(pct);
        expect(Number(row.commission)).toBe(Math.round((8750 * pct) / 100));
        expect(await driverStatus(world.prisma, winnerCompany, winnerDriver.driverId)).toBe('on_trip');
        expect(await driverStatus(world.prisma, loserCompany, loserDriver.driverId)).toBe('available');

        const accepted = (await offersOfTrip(world.prisma, winnerCompany, trip.tripRequestId)).filter(
          (offer) => offer.status === 'accepted',
        );
        expect(accepted).toHaveLength(1);
      }
    });

    it('la perdedora no ve el viaje por la API de su empresa mientras su oferta siga notificada', async () => {
      const { driverA, driverB, offerA, offerB, trip } = await twoOffers();
      expect((await accept(offerA, driverA, companyA)).body.result).toBe('accepted');

      const loserOffers = await http
        .get('/assignments/nearby')
        .set('Authorization', driverAuth(world.jwt, driverB.driverId, companyB));
      expect(loserOffers.status).toBe(200);
      expect(loserOffers.body).toEqual([]);

      const late = await accept(offerB, driverB, companyB);
      expect(late.body.result).toBe('already_taken');
      expect((await tripRow(world.prisma, trip.tripRequestId)).companyId).toBe(companyA);
    });
  });

  describe('la oferta concreta manda (MD-15)', () => {
    async function singleOffer(status?: 'rejected' | 'timeout' | 'cancelled', expiresInSec?: number) {
      const driver = await createDriver(world.prisma, companyA, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyA, {
        ...(status ? { status } : {}),
        ...(expiresInSec !== undefined ? { expiresInSec } : {}),
      });
      return { driver, trip, offerId };
    }

    it('una oferta rechazada responde already_taken y el viaje sigue pendiente', async () => {
      const { driver, trip, offerId } = await singleOffer('rejected');

      const res = await accept(offerId, driver, companyA);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ result: 'already_taken' });
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('pending_assignment');
      expect(await driverStatus(world.prisma, companyA, driver.driverId)).toBe('available');
    });

    it('una oferta marcada timeout responde expired y el viaje sigue pendiente', async () => {
      const { driver, trip, offerId } = await singleOffer('timeout');

      const res = await accept(offerId, driver, companyA);

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ result: 'expired' });
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('pending_assignment');
    });

    it('una oferta vencida que nadie marcó responde expired y el viaje sigue pendiente', async () => {
      const { driver, trip, offerId } = await singleOffer(undefined, -30);

      const res = await accept(offerId, driver, companyA);

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ result: 'expired' });
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('pending_assignment');
    });

    it('la oferta de otro conductor con su propio assignment_id responde 403 NOT_THE_DRIVER y no toma el viaje', async () => {
      const { trip, offerId } = await singleOffer();
      const intruder = await createDriver(world.prisma, companyA, NEAR);

      const res = await accept(offerId, intruder, companyA);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'NOT_THE_DRIVER' });
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('pending_assignment');
      expect(await driverStatus(world.prisma, companyA, intruder.driverId)).toBe('available');
    });

    it('la toma de un viaje dirigido a otra empresa no prospera aunque haya una oferta viva', async () => {
      const driverB = await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER, { requestedCompanyId: companyA });
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driverB, companyB);

      const res = await accept(offerId, driverB, companyB);

      expect(res.body).toMatchObject({ result: 'already_taken' });
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('pending_assignment');
    });
  });

  describe('comisión fijada al aceptar', () => {
    it('se calcula con la comisión vigente de la empresa que acepta y un cambio posterior no altera el viaje', async () => {
      const driver = await createDriver(world.prisma, companyC, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER, { fare: 9000 });
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyC);

      expect((await accept(offerId, driver, companyC)).body.result).toBe('accepted');
      const before = await tripRow(world.prisma, trip.tripRequestId);
      expect(Number(before.commissionPct)).toBe(COMMISSION_C);
      expect(Number(before.commission)).toBe(1080);

      await changeCommission(companyC, 20);

      const after = await tripRow(world.prisma, trip.tripRequestId);
      expect(Number(after.commissionPct)).toBe(COMMISSION_C);
      expect(Number(after.commission)).toBe(1080);
      await changeCommission(companyC, COMMISSION_C);
    });

    it('en la reasignación B -> C el viaje queda con la comisión de C', async () => {
      const driverB = await createDriver(world.prisma, companyB, NEAR);
      const driverC = await createDriver(world.prisma, companyC, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER, { fare: 8000 });
      const offerB = await createOffer(world.prisma, trip.tripRequestId, driverB, companyB);
      expect((await accept(offerB, driverB, companyB)).body.result).toBe('accepted');
      expect(Number((await tripRow(world.prisma, trip.tripRequestId)).commissionPct)).toBe(COMMISSION_B);

      const cancel = await http
        .post(`/assignments/${offerB}/cancel`)
        .set('Authorization', driverAuth(world.jwt, driverB.driverId, companyB))
        .send({ reason: 'no puedo hacer el servicio' });
      expect(cancel.status).toBe(200);
      const offerC = await createOffer(world.prisma, trip.tripRequestId, driverC, companyC);
      expect((await accept(offerC, driverC, companyC)).body.result).toBe('accepted');

      const row = await tripRow(world.prisma, trip.tripRequestId);
      expect(row.companyId).toBe(companyC);
      expect(Number(row.commissionPct)).toBe(COMMISSION_C);
      expect(Number(row.commission)).toBe(960);
    });

    it('una empresa sin comisión vigente no puede tomar: la toma falla de forma visible y no cambia nada', async () => {
      const noCommission = await createOperatingCompany(world.prisma, municipalityId, { commissionPct: null });
      const driver = await createDriver(world.prisma, noCommission, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, noCommission);

      const res = await accept(offerId, driver, noCommission);

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: 'COMMISSION_NOT_CONFIGURED' });
      const row = await tripRow(world.prisma, trip.tripRequestId);
      expect(row.status).toBe('pending_assignment');
      expect(row.companyId).toBeNull();
      expect(await driverStatus(world.prisma, noCommission, driver.driverId)).toBe('available');
      expect(await assignmentStatus(world.prisma, noCommission, offerId)).toBe('notified');
    });
  });

  describe('el conductor cancela en assigned un "Cualquiera" con dos empresas (MD-18)', () => {
    it('responde 200 con searching_again, vacía la empresa y la comisión y libera al conductor', async () => {
      const driver = await createDriver(world.prisma, companyA, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER, { fare: 8750 });
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyA);
      expect((await accept(offerId, driver, companyA)).body.result).toBe('accepted');
      expect((await tripRow(world.prisma, trip.tripRequestId)).companyId).toBe(companyA);

      const cancel = await http
        .post(`/assignments/${offerId}/cancel`)
        .set('Authorization', driverAuth(world.jwt, driver.driverId, companyA))
        .send({ reason: 'tuve un imprevisto' });

      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({
        trip_request_status: 'pending_assignment',
        searching_again: true,
      });
      const row = await tripRow(world.prisma, trip.tripRequestId);
      expect(row.status).toBe('pending_assignment');
      expect(row.companyId).toBeNull();
      expect(row.commissionPct).toBeNull();
      expect(Number(row.commission)).toBe(0);
      expect(await assignmentStatus(world.prisma, companyA, offerId)).toBe('cancelled');
      expect(await driverStatus(world.prisma, companyA, driver.driverId)).toBe('available');
    });

    it('control: cerrar primero la asignación y reabrir después viola la RLS de trip_request', async () => {
      const driver = await createDriver(world.prisma, companyA, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyA);
      expect((await accept(offerId, driver, companyA)).body.result).toBe('accepted');
      const repo = world.moduleRef.get(AssignmentRepository);

      const wrongOrder = world.prisma.runInTenant(companyA, async (tx) => {
        await repo.markCancelledByDriver(tx, offerId, companyA, 'orden incorrecto');
        await repo.reopenTripRequest(tx, trip.tripRequestId);
      });

      await expect(wrongOrder).rejects.toThrow(/row-level security/i);
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('assigned');
    });
  });

  describe('viaje cancelado después de aceptar y reportes (HU-MS-15)', () => {
    it('solo el viaje completado cuenta en la conciliación con su comisión; el cancelado después de aceptar no', async () => {
      const company = await createOperatingCompany(world.prisma, municipalityId, { commissionPct: 8 });
      const adminId = await createAdminUser(world.prisma, company);
      const admin = adminAuth(world.jwt, adminId, company);
      const driver = await createDriver(world.prisma, company, NEAR);
      const auth = driverAuth(world.jwt, driver.driverId, company);

      const completedTrip = await createPendingTrip(world.prisma, municipalityId, CENTER, { fare: 8750 });
      const offerOne = await createOffer(world.prisma, completedTrip.tripRequestId, driver, company);
      expect((await accept(offerOne, driver, company)).body.result).toBe('accepted');
      for (const step of ['en-route', 'arrived', 'start']) {
        const body = step === 'start' ? { start_code: await startCodeOf(world.prisma, completedTrip.tripRequestId) } : {};
        expect((await http.post(`/trips/${completedTrip.tripRequestId}/${step}`).set('Authorization', auth).send(body)).status).toBe(200);
      }
      expect(
        (await http.post(`/trips/${completedTrip.tripRequestId}/complete`).set('Authorization', auth).send({ cash_collected: true })).status,
      ).toBe(200);

      const cancelledTrip = await createPendingTrip(world.prisma, municipalityId, CENTER, { fare: 9500 });
      const offerTwo = await createOffer(world.prisma, cancelledTrip.tripRequestId, driver, company);
      expect((await accept(offerTwo, driver, company)).body.result).toBe('accepted');
      const cancelled = await http
        .post(`/trips/${cancelledTrip.tripRequestId}/cancel`)
        .set('Authorization', passengerAuth(world.jwt, cancelledTrip.passengerId))
        .send({});
      expect(cancelled.status).toBe(200);

      const today = settlementToday();
      const report = await http
        .get('/admin/reports/settlement')
        .set('Authorization', admin)
        .query({ from: addDays(today, -1), to: addDays(today, 1) });

      expect(report.status).toBe(200);
      expect(report.body.totals).toMatchObject({ trip_count: 1, cash_collected: 8750, commission: 700 });
      expect(await driverStatus(world.prisma, company, driver.driverId)).toBe('available');
    });
  });

  describe('el viaje es de la empresa que lo tomó (H-1, MD-10)', () => {
    it('el pasajero ve a su conductor con el nombre de la empresa que lo tomó, aunque no sea la de menor id', async () => {
      const driver = await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyB);
      expect((await accept(offerId, driver, companyB)).body.result).toBe('accepted');

      const status = await http
        .get(`/trips/${trip.tripRequestId}`)
        .set('Authorization', passengerAuth(world.jwt, trip.passengerId));

      expect(status.status).toBe(200);
      expect(status.body.driver.company).toEqual({ company_id: companyB, display_name: 'Beta Taxis' });
    });

    it('el pasajero cancela un viaje tomado por la segunda empresa y su conductor queda libre (no on_trip para siempre)', async () => {
      const driver = await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyB);
      expect((await accept(offerId, driver, companyB)).body.result).toBe('accepted');

      const cancelled = await http
        .post(`/trips/${trip.tripRequestId}/cancel`)
        .set('Authorization', passengerAuth(world.jwt, trip.passengerId))
        .send({});

      expect(cancelled.status).toBe(200);
      expect(await driverStatus(world.prisma, companyB, driver.driverId)).toBe('available');
      expect(await assignmentStatus(world.prisma, companyB, offerId)).toBe('cancelled');
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('cancelled_by_passenger');
    });

    it('un conductor de A no puede hacer ninguna de las seis transiciones sobre un viaje de B y el estado no cambia', async () => {
      const ownerDriver = await createDriver(world.prisma, companyB, NEAR);
      const intruder = await createDriver(world.prisma, companyA, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, ownerDriver, companyB);
      expect((await accept(offerId, ownerDriver, companyB)).body.result).toBe('accepted');
      const intruderAuth = driverAuth(world.jwt, intruder.driverId, companyA);
      const before = await tripRow(world.prisma, trip.tripRequestId);

      const attempts = [
        http.post(`/trips/${trip.tripRequestId}/en-route`).set('Authorization', intruderAuth).send({}),
        http.post(`/trips/${trip.tripRequestId}/arrived`).set('Authorization', intruderAuth).send({}),
        http.post(`/trips/${trip.tripRequestId}/start`).set('Authorization', intruderAuth).send({}),
        http.post(`/trips/${trip.tripRequestId}/complete`).set('Authorization', intruderAuth).send({ cash_collected: true }),
        http.post(`/trips/${trip.tripRequestId}/no-show`).set('Authorization', intruderAuth).send({}),
        http.post(`/trips/${trip.tripRequestId}/cash-collected`).set('Authorization', intruderAuth).send({}),
      ];
      for (const response of await Promise.all(attempts)) {
        expect([403, 404]).toContain(response.status);
      }

      const after = await tripRow(world.prisma, trip.tripRequestId);
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(await driverStatus(world.prisma, companyB, ownerDriver.driverId)).toBe('on_trip');
    });

    it('si el conductor cancela con el viaje ya en camino, termina cancelado por el conductor, sigue siendo de su empresa y no cuenta en la conciliación', async () => {
      const company = await createOperatingCompany(world.prisma, municipalityId, { commissionPct: 8 });
      const adminId = await createAdminUser(world.prisma, company);
      const driver = await createDriver(world.prisma, company, NEAR);
      const auth = driverAuth(world.jwt, driver.driverId, company);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER, { fare: 9000 });
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, company);
      expect((await accept(offerId, driver, company)).body.result).toBe('accepted');
      expect((await http.post(`/trips/${trip.tripRequestId}/en-route`).set('Authorization', auth).send({})).status).toBe(200);

      const cancel = await http
        .post(`/assignments/${offerId}/cancel`)
        .set('Authorization', auth)
        .send({ reason: 'se me dañó el carro' });

      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ trip_request_status: 'cancelled_by_driver', searching_again: false });
      const row = await tripRow(world.prisma, trip.tripRequestId);
      expect(row.status).toBe('cancelled_by_driver');
      expect(row.companyId).toBe(company);
      const today = settlementToday();
      const report = await http
        .get('/admin/reports/settlement')
        .set('Authorization', adminAuth(world.jwt, adminId, company))
        .query({ from: addDays(today, -1), to: addDays(today, 1) });
      expect(report.body.totals).toMatchObject({ trip_count: 0, commission: 0 });
      expect(await driverStatus(world.prisma, company, driver.driverId)).toBe('available');
    });
  });

  describe('la cancelación del pasajero compite con la toma (MD-05)', () => {
    const owner = ownerClient();
    const barrier = owner ? it : it.skip;

    async function raceOrders(first: 'accept' | 'cancel') {
      const driver = await createDriver(world.prisma, companyA, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyA);
      const holder = new PrismaClient({ datasourceUrl: url });
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let holding: () => void = () => undefined;
      const holdingLock = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const held = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM trips.trip_request WHERE trip_request_id = ${trip.tripRequestId} FOR UPDATE`;
          holding();
          await gate;
        },
        { timeout: 60_000, maxWait: 60_000 },
      );
      await holdingLock;

      const startAccept = () => accept(offerId, driver, companyA).then((res) => res);
      const startCancel = () =>
        http
          .post(`/trips/${trip.tripRequestId}/cancel`)
          .set('Authorization', passengerAuth(world.jwt, trip.passengerId))
          .send({})
          .then((res) => res);

      const starters = first === 'accept' ? [startAccept, startCancel] : [startCancel, startAccept];
      const pending: Array<Promise<request.Response>> = [];
      for (const [index, start] of starters.entries()) {
        pending.push(start());
        await waitForLockWaiters(owner as NonNullable<typeof owner>, index + 1, 'trips.trip_request');
      }
      openGate();
      await held;
      await holder.$disconnect();
      const responses = await Promise.all(pending);
      const acceptRes = first === 'accept' ? responses[0] : responses[1];
      const cancelRes = first === 'accept' ? responses[1] : responses[0];
      return { driver, trip, offerId, acceptRes, cancelRes };
    }

    barrier('si gana la toma, el viaje termina cancelado, la asignación cerrada y el conductor liberado (no queda on_trip)', async () => {
      const { driver, trip, offerId, acceptRes, cancelRes } = await raceOrders('accept');

      expect(acceptRes?.status).toBe(200);
      expect(acceptRes?.body.result).toBe('accepted');
      expect(cancelRes?.status).toBe(200);
      expect(cancelRes?.body.status).toBe('cancelled_by_passenger');
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('cancelled_by_passenger');
      expect(await assignmentStatus(world.prisma, companyA, offerId)).toBe('cancelled');
      expect(await driverStatus(world.prisma, companyA, driver.driverId)).toBe('available');
    });

    barrier('si gana la cancelación, la toma responde already_taken y el conductor nunca queda on_trip', async () => {
      const { driver, trip, offerId, acceptRes, cancelRes } = await raceOrders('cancel');

      expect(cancelRes?.status).toBe(200);
      expect(acceptRes?.status).toBe(409);
      expect(acceptRes?.body.result).toBe('already_taken');
      const row = await tripRow(world.prisma, trip.tripRequestId);
      expect(row.status).toBe('cancelled_by_passenger');
      expect(row.companyId).toBeNull();
      expect(await assignmentStatus(world.prisma, companyA, offerId)).not.toBe('accepted');
      expect(await driverStatus(world.prisma, companyA, driver.driverId)).toBe('available');
    });

    it('un no_driver tardío no pisa un viaje que otra empresa ya tomó', async () => {
      const driver = await createDriver(world.prisma, companyA, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyA);
      expect((await accept(offerId, driver, companyA)).body.result).toBe('accepted');

      await world.moduleRef.get(EventEmitter2).emitAsync('trip_request.no_driver', {
        trip_request_id: trip.tripRequestId,
        attempts_made: 3,
        final_radius_km: 5,
        occurred_at: new Date().toISOString(),
      });

      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('assigned');
    });
  });
});
