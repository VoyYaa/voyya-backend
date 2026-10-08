import request from 'supertest';
import {
  type World,
  bootWorld,
  createCoveredMunicipality,
  createDriver,
  createOperatingCompany,
  createPendingTrip,
  offersOfTrip,
  passengerAuth,
} from './support/dispatch-world';
import { createFreshPassenger } from './support/fresh-passenger';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_McNoCommission';
const CENTER = { lat: 14.35, lng: -68.95 };

jest.setTimeout(60_000);

suite('Empresa activa sin comisión abierta queda fuera del reparto y de service-options (MV-05)', () => {
  let world: World;
  let municipalityId: number;
  let withCommission: number;
  let withoutCommission: number;

  beforeAll(async () => {
    world = await bootWorld();
    municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, CENTER);
    withCommission = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Con Comision' });
    withoutCommission = await createOperatingCompany(world.prisma, municipalityId, {
      publicName: 'Sin Comision',
      commissionPct: null,
    });
  });

  afterAll(async () => {
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
  });

  it('service-options solo lista la empresa con comisión', async () => {
    const passengerId = await createFreshPassenger(world.prisma);
    const res = await request(world.app.getHttpServer())
      .get('/trips/service-options')
      .set('Authorization', passengerAuth(world.jwt, passengerId))
      .query(CENTER);

    expect(res.status).toBe(200);
    const companies = res.body.services[0].companies as Array<{ company_id: number }>;
    expect(companies.map((company) => company.company_id)).toEqual([withCommission]);
  });

  it('el reparto no ofrece el viaje a la empresa sin comisión aunque tenga el conductor más cercano', async () => {
    const near = { lat: CENTER.lat + 0.001, lng: CENTER.lng };
    const far = { lat: CENTER.lat + 0.004, lng: CENTER.lng };
    await createDriver(world.prisma, withoutCommission, near);
    const farDriver = await createDriver(world.prisma, withCommission, far);
    const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);

    await world.assignment.onTripRequestCreated({
      trip_request_id: trip.tripRequestId,
      passenger_id: trip.passengerId,
      municipality_id: municipalityId,
      service_type: 'taxi',
      origin: CENTER,
      occurred_at: new Date().toISOString(),
    });

    expect(await offersOfTrip(world.prisma, withoutCommission, trip.tripRequestId)).toEqual([]);
    const offers = await offersOfTrip(world.prisma, withCommission, trip.tripRequestId);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ driverId: farDriver.driverId, status: 'notified' });
  });
});
