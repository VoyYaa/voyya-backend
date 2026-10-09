import { TRIPS_EVENTS } from '@voyyaa/shared';
import request from 'supertest';
import { AssignmentRepository } from '../src/modules/assignment/assignment.repository';
import {
  type World,
  assignmentStatus,
  bootWorld,
  createCoveredMunicipality,
  createDriver,
  createOffer,
  createOperatingCompany,
  createPendingTrip,
  driverAuth,
  driverStatus,
  offersOfTrip,
  ownerClient,
  tripRow,
  waitForLockWaiters,
} from './support/dispatch-world';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_McDispatch';
const CENTER = { lat: 12.05, lng: -70.05 };
const PICKUP = CENTER;
const NEAR = { lat: CENTER.lat + 0.001, lng: CENTER.lng };
const FAR = { lat: CENTER.lat + 0.004, lng: CENTER.lng };

jest.setTimeout(60_000);

suite('Reparto entre empresas contra Postgres real como app_voyya (ADR-032 §1, §15.1)', () => {
  let world: World;
  let municipalityId: number;
  let companyA: number;
  let companyB: number;

  const startChain = async (tripRequestId: number, passengerId: number): Promise<void> =>
    world.assignment.onTripRequestCreated({
      trip_request_id: tripRequestId,
      passenger_id: passengerId,
      municipality_id: municipalityId,
      service_type: 'taxi',
      origin: PICKUP,
      occurred_at: new Date().toISOString(),
    });

  async function liveOfferOf(tripRequestId: number) {
    const all = [
      ...(await offersOfTrip(world.prisma, companyA, tripRequestId)),
      ...(await offersOfTrip(world.prisma, companyB, tripRequestId)),
    ];
    return all.filter((offer) => offer.status === 'notified');
  }

  async function cancelLiveOffers(): Promise<void> {
    for (const companyId of [companyA, companyB]) {
      await world.prisma.runInTenant(companyId, (tx) =>
        tx.$executeRaw`UPDATE assignment.assignment SET status = 'cancelled' WHERE status = 'notified'`,
      );
    }
  }

  async function freeEveryone(): Promise<void> {
    for (const companyId of [companyA, companyB]) {
      await world.prisma.runInTenant(companyId, async (tx) => {
        await tx.$executeRaw`UPDATE assignment.assignment SET status = 'cancelled' WHERE status = 'notified'`;
        await tx.$executeRaw`UPDATE fleet.driver SET status = 'off_shift' WHERE status = 'available'`;
      });
    }
  }

  beforeAll(async () => {
    world = await bootWorld();
    municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, CENTER);
    companyA = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Alfa Taxis' });
    companyB = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Beta Taxis' });
  });

  afterAll(async () => {
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
  });

  beforeEach(freeEveryone);

  describe('"Cualquiera" con dos empresas', () => {
    it('gana el conductor más cercano de cualquiera de las dos empresas', async () => {
      const farA = await createDriver(world.prisma, companyA, FAR);
      const nearB = await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);

      await startChain(trip.tripRequestId, trip.passengerId);

      const [offer] = await liveOfferOf(trip.tripRequestId);
      expect(offer).toMatchObject({ driverId: nearB.driverId, companyId: companyB });
      expect(await driverStatus(world.prisma, companyA, farA.driverId)).toBe('available');
    });

    it('sin sesgo por empresa: el más cercano gana también cuando es el de la otra empresa', async () => {
      const nearA = await createDriver(world.prisma, companyA, NEAR);
      await createDriver(world.prisma, companyB, FAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);

      await startChain(trip.tripRequestId, trip.passengerId);

      const [offer] = await liveOfferOf(trip.tripRequestId);
      expect(offer).toMatchObject({ driverId: nearA.driverId, companyId: companyA });
    });

    it('con dos conductores exactamente a la misma distancia ninguna empresa gana siempre (desempate al azar)', async () => {
      await createDriver(world.prisma, companyA, NEAR);
      await createDriver(world.prisma, companyB, NEAR);
      const winners = new Set<number>();

      for (let round = 0; round < 24 && winners.size < 2; round += 1) {
        const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
        await startChain(trip.tripRequestId, trip.passengerId);
        const [offer] = await liveOfferOf(trip.tripRequestId);
        winners.add(offer?.companyId ?? 0);
        await cancelLiveOffers();
      }

      expect(winners).toEqual(new Set([companyA, companyB]));
    });

    it('el reparto no consume reintentos por una empresa sin conductores: A sin nadie, B con uno', async () => {
      const onlyB = await createDriver(world.prisma, companyB, FAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);

      await startChain(trip.tripRequestId, trip.passengerId);

      const [offer] = await liveOfferOf(trip.tripRequestId);
      expect(offer).toMatchObject({ driverId: onlyB.driverId, companyId: companyB, attemptOrder: 1 });
    });
  });

  describe('empresa pedida', () => {
    it('solo se ofrece a los conductores de esa empresa, aunque el de la otra esté más cerca', async () => {
      const farA = await createDriver(world.prisma, companyA, FAR);
      await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP, {
        requestedCompanyId: companyA,
      });

      await startChain(trip.tripRequestId, trip.passengerId);

      const offers = await liveOfferOf(trip.tripRequestId);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({ driverId: farA.driverId, companyId: companyA });
    });

    it('si la empresa pedida no tiene conductores, el viaje termina sin conductor aunque la otra tenga', async () => {
      await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP, {
        requestedCompanyId: companyA,
      });

      await startChain(trip.tripRequestId, trip.passengerId);
      await settle();

      expect(await liveOfferOf(trip.tripRequestId)).toHaveLength(0);
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('no_driver');
    });
  });

  describe('empresa suspendida (P-21)', () => {
    it('no recibe ofertas nuevas: con "Cualquiera" el conductor de la activa recibe el viaje', async () => {
      const suspended = await createOperatingCompany(world.prisma, municipalityId, { status: 'suspended' });
      const nearSuspended = await createDriver(world.prisma, suspended, NEAR);
      const farB = await createDriver(world.prisma, companyB, FAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);

      await startChain(trip.tripRequestId, trip.passengerId);

      const [offer] = await liveOfferOf(trip.tripRequestId);
      expect(offer).toMatchObject({ driverId: farB.driverId, companyId: companyB });
      expect(await driverStatus(world.prisma, suspended, nearSuspended.driverId)).toBe('available');
    });

    it('un viaje dirigido a una empresa que se suspende antes de la búsqueda pasa a no_driver', async () => {
      const directed = await createOperatingCompany(world.prisma, municipalityId);
      await createDriver(world.prisma, directed, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP, {
        requestedCompanyId: directed,
      });
      await world.prisma.company.update({ where: { companyId: directed }, data: { status: 'suspended' } });

      await startChain(trip.tripRequestId, trip.passengerId);
      await settle();

      expect(await offersOfTrip(world.prisma, directed, trip.tripRequestId)).toHaveLength(0);
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('no_driver');
    });

    it('una empresa suspendida a mitad de la cadena no recibe la siguiente oferta', async () => {
      const midChain = await createOperatingCompany(world.prisma, municipalityId);
      const first = await createDriver(world.prisma, midChain, NEAR);
      const second = await createDriver(world.prisma, midChain, FAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP, {
        requestedCompanyId: midChain,
      });
      await startChain(trip.tripRequestId, trip.passengerId);
      const [firstOffer] = await offersOfTrip(world.prisma, midChain, trip.tripRequestId);
      expect(firstOffer?.driverId).toBe(first.driverId);

      await world.prisma.company.update({ where: { companyId: midChain }, data: { status: 'suspended' } });
      await world.assignment.reject(firstOffer?.assignmentId ?? 0, first.driverId, midChain, {});
      await settle();

      const offers = await offersOfTrip(world.prisma, midChain, trip.tripRequestId);
      expect(offers).toHaveLength(1);
      expect(await driverStatus(world.prisma, midChain, second.driverId)).toBe('available');
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('no_driver');
    });

    it('una oferta viva de una empresa que se suspende no se puede aceptar: la toma responde already_taken', async () => {
      const driver = await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyB);
      await world.prisma.company.update({ where: { companyId: companyB }, data: { status: 'suspended' } });

      try {
        const result = await world.assignment.accept(offerId, driver.driverId, companyB, {});
        expect(result.result).toBe('already_taken');
      } finally {
        await world.prisma.company.update({ where: { companyId: companyB }, data: { status: 'active' } });
      }

      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('pending_assignment');
      expect(await driverStatus(world.prisma, companyB, driver.driverId)).toBe('available');
    });

    it('los viajes ya aceptados por la empresa que se suspende terminan normal', async () => {
      const driver = await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyB);
      expect((await world.assignment.accept(offerId, driver.driverId, companyB, {})).result).toBe('accepted');
      await world.prisma.company.update({ where: { companyId: companyB }, data: { status: 'suspended' } });

      try {
        const http = request(world.app.getHttpServer());
        const auth = driverAuth(world.jwt, driver.driverId, companyB);
        expect((await http.post(`/trips/${trip.tripRequestId}/en-route`).set('Authorization', auth).send({})).status).toBe(200);
        expect((await http.post(`/trips/${trip.tripRequestId}/arrived`).set('Authorization', auth).send({})).status).toBe(200);
        expect((await http.post(`/trips/${trip.tripRequestId}/start`).set('Authorization', auth).send({})).status).toBe(200);
        const completed = await http
          .post(`/trips/${trip.tripRequestId}/complete`)
          .set('Authorization', auth)
          .send({ cash_collected: true });
        expect(completed.status).toBe(200);
        expect(completed.body.status).toBe('completed');
      } finally {
        await world.prisma.company.update({ where: { companyId: companyB }, data: { status: 'active' } });
      }
    });
  });

  describe('una oferta por conductor (H-4, MD-02)', () => {
    it('dos cadenas que eligen al mismo conductor crean una sola oferta; la otra termina sin conductor', async () => {
      const only = await createDriver(world.prisma, companyA, NEAR);
      const first = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      const second = await createPendingTrip(world.prisma, municipalityId, PICKUP);

      await Promise.all([
        startChain(first.tripRequestId, first.passengerId),
        startChain(second.tripRequestId, second.passengerId),
      ]);
      await settle();

      const live = [...(await liveOfferOf(first.tripRequestId)), ...(await liveOfferOf(second.tripRequestId))];
      expect(live).toHaveLength(1);
      expect(live[0]?.driverId).toBe(only.driverId);
      const statuses = [
        (await tripRow(world.prisma, first.tripRequestId)).status,
        (await tripRow(world.prisma, second.tripRequestId)).status,
      ].sort();
      expect(statuses).toEqual(['no_driver', 'pending_assignment']);
    });

    const owner = ownerClient();
    const barrier = owner ? it : it.skip;

    barrier(
      'con dos conexiones reales y una barrera, la segunda espera el bloqueo y al despertar ve la oferta de la primera',
      async () => {
        const driver = await createDriver(world.prisma, companyA, NEAR);
        const tripOne = await createPendingTrip(world.prisma, municipalityId, PICKUP);
        const tripTwo = await createPendingTrip(world.prisma, municipalityId, PICKUP);
        const repo = world.moduleRef.get(AssignmentRepository);
        const data = (tripRequestId: number, attemptOrder: number) => ({
          tripRequestId,
          driverId: driver.driverId,
          vehicleId: driver.vehicleId,
          companyId: companyA,
          attemptOrder,
          expiresAt: new Date(Date.now() + 60_000),
        });

        let releaseFirst: () => void = () => undefined;
        const firstMayCommit = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let firstHoldsLock: () => void = () => undefined;
        const firstReady = new Promise<void>((resolve) => {
          firstHoldsLock = resolve;
        });

        const first = world.prisma.runInTenant(companyA, async (tx) => {
          const offer = await repo.createOfferIfDriverFree(tx, data(tripOne.tripRequestId, 1));
          firstHoldsLock();
          await firstMayCommit;
          return offer;
        });
        await firstReady;

        const second = world.prisma.runInTenant(companyA, (tx) =>
          repo.createOfferIfDriverFree(tx, data(tripTwo.tripRequestId, 1)),
        );
        await waitForLockWaiters(owner as NonNullable<typeof owner>, 1, 'FROM fleet.driver');
        releaseFirst();

        const [firstOffer, secondOffer] = await Promise.all([first, second]);

        expect(firstOffer).not.toBeNull();
        expect(secondOffer).toBeNull();
        const live = [...(await liveOfferOf(tripOne.tripRequestId)), ...(await liveOfferOf(tripTwo.tripRequestId))];
        expect(live).toHaveLength(1);
        await owner?.$disconnect();
      },
    );

    it('a quien rechazó el viaje no se le vuelve a ofrecer en la cadena nueva', async () => {
      const rejecter = await createDriver(world.prisma, companyA, NEAR);
      const other = await createDriver(world.prisma, companyA, FAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      await createOffer(world.prisma, trip.tripRequestId, rejecter, companyA, { status: 'rejected' });

      await startChain(trip.tripRequestId, trip.passengerId);

      const [offer] = await liveOfferOf(trip.tripRequestId);
      expect(offer?.driverId).toBe(other.driverId);
    });

    it('a quien dejó vencer o canceló el viaje tampoco', async () => {
      const timedOut = await createDriver(world.prisma, companyA, NEAR);
      const cancelled = await createDriver(world.prisma, companyA, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      await createOffer(world.prisma, trip.tripRequestId, timedOut, companyA, { status: 'timeout' });
      await createOffer(world.prisma, trip.tripRequestId, cancelled, companyA, { status: 'cancelled' });

      await startChain(trip.tripRequestId, trip.passengerId);
      await settle();

      expect(await liveOfferOf(trip.tripRequestId)).toHaveLength(0);
      expect((await tripRow(world.prisma, trip.tripRequestId)).status).toBe('no_driver');
    });

    it('un conductor con una oferta viva de otro viaje no es candidato', async () => {
      const busy = await createDriver(world.prisma, companyA, NEAR);
      const free = await createDriver(world.prisma, companyA, FAR);
      const otherTrip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      await createOffer(world.prisma, otherTrip.tripRequestId, busy, companyA);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);

      await startChain(trip.tripRequestId, trip.passengerId);

      const [offer] = await liveOfferOf(trip.tripRequestId);
      expect(offer?.driverId).toBe(free.driverId);
    });
  });

  describe('ofertas visibles para el conductor (MD-03)', () => {
    it('GET /assignments/nearby muestra la oferta viva y desaparece sin error cuando otra empresa toma el viaje', async () => {
      const driverA = await createDriver(world.prisma, companyA, NEAR);
      const driverB = await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      const offerA = await createOffer(world.prisma, trip.tripRequestId, driverA, companyA);
      await createOffer(world.prisma, trip.tripRequestId, driverB, companyB);
      const http = request(world.app.getHttpServer());
      const authA = driverAuth(world.jwt, driverA.driverId, companyA);
      const authB = driverAuth(world.jwt, driverB.driverId, companyB);

      const before = await http.get('/assignments/nearby').set('Authorization', authB);
      expect(before.status).toBe(200);
      expect(before.body).toHaveLength(1);

      const take = await http.post(`/assignments/${offerA}/accept`).set('Authorization', authA).send({});
      expect(take.status).toBe(200);

      const after = await http.get('/assignments/nearby').set('Authorization', authB);
      expect(after.status).toBe(200);
      expect(after.body).toEqual([]);
    });

    it('una oferta vencida que nadie marcó timeout no aparece', async () => {
      const driver = await createDriver(world.prisma, companyA, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      await createOffer(world.prisma, trip.tripRequestId, driver, companyA, { expiresInSec: -3600 });

      const res = await request(world.app.getHttpServer())
        .get('/assignments/nearby')
        .set('Authorization', driverAuth(world.jwt, driver.driverId, companyA));

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('vencimiento y cancelación de la oferta viva', () => {
    it('el pasajero cancelando un "Cualquiera" cancela la oferta viva en la empresa que la hizo', async () => {
      const driver = await createDriver(world.prisma, companyB, NEAR);
      const trip = await createPendingTrip(world.prisma, municipalityId, PICKUP);
      await startChain(trip.tripRequestId, trip.passengerId);
      const [offer] = await liveOfferOf(trip.tripRequestId);
      expect(offer?.driverId).toBe(driver.driverId);

      await world.assignment.onTripRequestCancelled({
        trip_request_id: trip.tripRequestId,
        cancelled_by: 'passenger',
        released_driver_id: null,
        occurred_at: new Date().toISOString(),
      });

      expect(await assignmentStatus(world.prisma, companyB, offer?.assignmentId ?? 0)).toBe('cancelled');
      expect(await driverStatus(world.prisma, companyB, driver.driverId)).toBe('available');
    });
  });

  it('el evento de creación sigue conectado al motor (no se rompió el cableado)', () => {
    expect(TRIPS_EVENTS.TRIP_REQUEST_CREATED).toBe('trip_request.created');
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});
