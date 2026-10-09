import { createHmac } from 'node:crypto';
import { addDays, settlementToday } from '@voyyaa/shared';
import request from 'supertest';
import { DispatchCompaniesResolver } from '../src/modules/tenancy/dispatch-companies.resolver';
import {
  type World,
  adminAuth,
  bootWorld,
  createAdminUser,
  createCoveredMunicipality,
  createDriver,
  createOperatingCompany,
  driverAuth,
  passengerAuth,
  tripRow,
} from './support/dispatch-world';
import { createFreshPassenger } from './support/fresh-passenger';
import { createCompany, createMunicipality } from './support/platform-fixtures';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_McTrips';
const QUOTE_SECRET = process.env.QUOTE_TOKEN_SECRET ?? 'test-quote-secret-0123456789-abcdefghij-xyz';

const centerOf = (index: number) => ({ lat: 12.05 + index * 0.15, lng: -69.65 });
const around = (center: { lat: number; lng: number }, dLat = 0, dLng = 0) => ({
  lat: center.lat + dLat,
  lng: center.lng + dLng,
});
const place = (center: { lat: number; lng: number }, dLat = 0, dLng = 0, address = 'Punto') => ({
  ...around(center, dLat, dLng),
  address,
});

jest.setTimeout(90_000);

suite('GET /trips/service-options, cotización y pedido con varias empresas, como app_voyya (ADR-032 §8.1, §15)', () => {
  let world: World;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    world = await bootWorld();
    http = request(world.app.getHttpServer());
  });

  afterAll(async () => {
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
  });

  async function passenger(): Promise<{ id: number; auth: string }> {
    const id = await createFreshPassenger(world.prisma);
    return { id, auth: passengerAuth(world.jwt, id) };
  }

  const options = (auth: string, point: { lat: number; lng: number }) =>
    http.get('/trips/service-options').set('Authorization', auth).query(point);

  describe('service-options', () => {
    it('con 0 empresas: el municipio sale por el pin y no hay servicios todavía', async () => {
      const center = centerOf(0);
      const municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, center);
      const { auth } = await passenger();

      const res = await options(auth, center);

      expect(res.status).toBe(200);
      expect(res.body.municipality).toMatchObject({ municipality_id: municipalityId });
      expect(res.body.services).toEqual([]);
    });

    it('con 1 empresa: sin selección y con el nombre público', async () => {
      const center = centerOf(1);
      const municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, center);
      const companyId = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Cootrayal' });
      await createDriver(world.prisma, companyId, around(center, 0.001));
      const { auth } = await passenger();

      const res = await options(auth, center);

      expect(res.status).toBe(200);
      expect(res.body.services).toEqual([
        {
          service_type: 'taxi',
          selection_required: false,
          companies: [{ company_id: companyId, display_name: 'Cootrayal', has_available_drivers: true }],
        },
      ]);
    });

    it('con 2 o más empresas: selección obligatoria, orden por nombre y disponibilidad por empresa, sin cantidades', async () => {
      const center = centerOf(2);
      const municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, center);
      const beta = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Beta Taxis' });
      const alfa = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Álamo Taxis' });
      await createOperatingCompany(world.prisma, municipalityId, { status: 'suspended', publicName: 'Suspendida' });
      await createDriver(world.prisma, alfa, around(center, 0.001));
      await createDriver(world.prisma, alfa, around(center, 0.002));
      await createDriver(world.prisma, beta, null, 'off_shift');
      const { auth } = await passenger();

      const res = await options(auth, center);

      expect(res.status).toBe(200);
      const [taxi] = res.body.services;
      expect(taxi.selection_required).toBe(true);
      expect(taxi.companies).toEqual([
        { company_id: alfa, display_name: 'Álamo Taxis', has_available_drivers: true },
        { company_id: beta, display_name: 'Beta Taxis', has_available_drivers: false },
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/count|drivers_count|lat|lng/i);
    });

    it('una empresa que no ofrece el servicio no aparece', async () => {
      const center = centerOf(3);
      const municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, center);
      await createCompany(world.prisma, municipalityId, { status: 'active', serviceTypes: ['comfort'] });
      const { auth } = await passenger();

      const res = await options(auth, center);

      expect(res.body.services).toEqual([]);
    });

    it('con coberturas superpuestas gana la más pequeña (la más específica)', async () => {
      const center = centerOf(4);
      const wide = await createCoveredMunicipality(world.prisma, PREFIX, center, { half: 0.1 });
      const narrow = await createCoveredMunicipality(world.prisma, PREFIX, center, { half: 0.02 });
      const { auth } = await passenger();

      const inside = await options(auth, center);
      const ring = await options(auth, around(center, 0.06));

      expect(inside.body.municipality.municipality_id).toBe(narrow);
      expect(ring.body.municipality.municipality_id).toBe(wide);
    });

    it('un punto fuera de toda cobertura activa: municipality null y sin servicios', async () => {
      const { auth } = await passenger();

      const res = await options(auth, { lat: 15.9, lng: -81.9 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ municipality: null, services: [] });
    });

    it('un municipio solo del catálogo (sin cobertura activa) no se resuelve', async () => {
      const { auth } = await passenger();
      await createMunicipality(world.prisma, PREFIX, { status: 'catalog' });

      const res = await options(auth, { lat: 15.9, lng: -81.9 });

      expect(res.body.municipality).toBeNull();
    });

    it('coordenadas inválidas -> 400; un conductor no puede llamarla -> 403', async () => {
      const { auth } = await passenger();

      expect((await options(auth, { lat: 90, lng: -70 })).status).toBe(400);
      expect((await http.get('/trips/service-options').set('Authorization', auth)).status).toBe(400);

      const municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, centerOf(5));
      const companyId = await createOperatingCompany(world.prisma, municipalityId);
      const driver = await createDriver(world.prisma, companyId, null, 'off_shift');
      const asDriver = await http
        .get('/trips/service-options')
        .set('Authorization', driverAuth(world.jwt, driver.driverId, companyId))
        .query(centerOf(5));
      expect(asDriver.status).toBe(403);
    });

    it('throttle por usuario (MD-13): la llamada 21 en un minuto responde 429 y otro pasajero desde la misma IP no se ve afectado', async () => {
      const first = await passenger();
      const second = await passenger();
      const point = { lat: 15.9, lng: -81.9 };

      for (let call = 1; call <= 20; call += 1) {
        expect((await options(first.auth, point)).status).toBe(200);
      }
      const blocked = await options(first.auth, point);

      expect(blocked.status).toBe(429);
      expect((await options(second.auth, point)).status).toBe(200);
    });
  });

  describe('cotización y pedido', () => {
    const quoteBody = (municipalityId: number, center: { lat: number; lng: number }, serviceType = 'taxi') => ({
      origin: place(center, 0.001, 0, 'Origen'),
      destination: place(center, 0.01, 0.005, 'Destino'),
      municipality_id: municipalityId,
      service_type: serviceType,
    });

    let nextMarket = 6;
    async function market() {
      const center = centerOf(nextMarket);
      nextMarket += 1;
      const municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, center);
      const alfa = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Alfa' });
      const beta = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Beta' });
      return { center, municipalityId, alfa, beta };
    }

    async function quoteAndCreate(
      m: Awaited<ReturnType<typeof market>>,
      requestedCompanyId?: number | null,
    ) {
      const rider = await passenger();
      const quote = await http
        .post('/trips/quote')
        .set('Authorization', rider.auth)
        .send(quoteBody(m.municipalityId, m.center));
      expect(quote.status).toBe(200);
      const created = await http
        .post('/trips')
        .set('Authorization', rider.auth)
        .send({
          ...quoteBody(m.municipalityId, m.center),
          payment_method: 'cash',
          quote_token: quote.body.quote_token,
          ...(requestedCompanyId !== undefined ? { requested_company_id: requestedCompanyId } : {}),
        });
      return { rider, quote, created };
    }

    it('el total es el mismo con la empresa A, con la B y con "Cualquiera", y la comisión que ve el pasajero es 0', async () => {
      const m = await market();

      const withAlfa = await quoteAndCreate(m, m.alfa);
      const withBeta = await quoteAndCreate(m, m.beta);
      const anyCompany = await quoteAndCreate(m, null);

      for (const result of [withAlfa, withBeta, anyCompany]) {
        expect(result.created.status).toBe(201);
        expect(result.created.body.fare.total).toBe(withAlfa.created.body.fare.total);
        expect(result.quote.body.fare.commission).toBe(0);
        expect(result.created.body.fare.commission).toBe(0);
      }
      const rowAlfa = await tripRow(world.prisma, withAlfa.created.body.trip_request_id);
      expect(rowAlfa).toMatchObject({ requestedCompanyId: m.alfa, addressedCompanyId: m.alfa, companyId: null });
      expect(Number(rowAlfa.commission)).toBe(0);
      const openFare = await world.prisma.municipalityFare.findFirstOrThrow({
        where: { municipalityId: m.municipalityId, validTo: null },
      });
      expect(rowAlfa.municipalityFareId).toBe(openFare.municipalityFareId);
      const rowAny = await tripRow(world.prisma, anyCompany.created.body.trip_request_id);
      expect(rowAny).toMatchObject({ requestedCompanyId: null, addressedCompanyId: null });
    });

    it('el estado del viaje devuelve el servicio, la empresa pedida y la tarifa de la versión guardada', async () => {
      const m = await market();
      const { rider, created } = await quoteAndCreate(m, m.beta);

      const status = await http
        .get(`/trips/${created.body.trip_request_id}`)
        .set('Authorization', rider.auth);

      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        service_type: 'taxi',
        requested_company: { company_id: m.beta, display_name: 'Beta' },
        driver: null,
        fare: { total: created.body.fare.total, commission: 0 },
      });
      const active = await http.get('/trips/active').set('Authorization', rider.auth);
      expect(active.body.active_trip.requested_company).toEqual({ company_id: m.beta, display_name: 'Beta' });
    });

    it('"Cualquiera" no nombra a ninguna empresa en el estado, también con dos empresas', async () => {
      const m = await market();
      const { rider, created } = await quoteAndCreate(m);

      const status = await http.get(`/trips/${created.body.trip_request_id}`).set('Authorization', rider.auth);

      expect(status.body.requested_company).toBeNull();
    });

    it('una empresa de otro municipio, suspendida o inexistente -> 409 COMPANY_NOT_AVAILABLE y no se crea nada', async () => {
      const m = await market();
      const other = await market();
      const suspended = await createOperatingCompany(world.prisma, m.municipalityId, { status: 'suspended' });

      for (const requested of [other.alfa, suspended, 99_999_999]) {
        const { created } = await quoteAndCreate(m, requested);
        expect(created.status).toBe(409);
        expect(created.body).toMatchObject({ code: 'COMPANY_NOT_AVAILABLE' });
      }
    });

    it('el disparador de la base rechaza la empresa que se suspende entre la validación y el insert -> 409 COMPANY_NOT_AVAILABLE', async () => {
      const m = await market();
      const suspended = await createOperatingCompany(world.prisma, m.municipalityId, { status: 'suspended' });
      const resolver = world.moduleRef.get(DispatchCompaniesResolver);
      const spy = jest.spyOn(resolver, 'resolve').mockResolvedValue([suspended]);

      try {
        const { created } = await quoteAndCreate(m, suspended);
        expect(created.status).toBe(409);
        expect(created.body).toMatchObject({ code: 'COMPANY_NOT_AVAILABLE' });
      } finally {
        spy.mockRestore();
      }
    });

    it('motorcycle se rechaza en el borde (400) y un servicio inactivo responde 409 SERVICE_NOT_AVAILABLE al cotizar y al pedir', async () => {
      const m = await market();
      const rider = await passenger();
      const base = quoteBody(m.municipalityId, m.center);

      const motorcycleQuote = await http.post('/trips/quote').set('Authorization', rider.auth).send({ ...base, service_type: 'motorcycle' });
      expect(motorcycleQuote.status).toBe(400);
      const motorcycleCreate = await http
        .post('/trips')
        .set('Authorization', rider.auth)
        .send({ ...base, service_type: 'motorcycle', payment_method: 'cash', quote_token: 'x' });
      expect(motorcycleCreate.status).toBe(400);

      for (const inactive of ['comfort', 'delivery']) {
        const quote = await http.post('/trips/quote').set('Authorization', rider.auth).send({ ...base, service_type: inactive });
        expect(quote.status).toBe(409);
        expect(quote.body).toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
        const create = await http
          .post('/trips')
          .set('Authorization', rider.auth)
          .send({ ...base, service_type: inactive, payment_method: 'cash', quote_token: 'x' });
        expect(create.status).toBe(409);
        expect(create.body).toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
      }
    });

    it('un token v1 (sin la versión de la tarifa) responde 410 QUOTE_EXPIRED', async () => {
      const m = await market();
      const rider = await passenger();
      const body = Buffer.from(
        JSON.stringify({
          municipalityId: m.municipalityId,
          serviceType: 'taxi',
          origin: { lat: m.center.lat + 0.001, lng: m.center.lng },
          destination: { lat: m.center.lat + 0.01, lng: m.center.lng + 0.005 },
          distanceKm: 1,
          fare: { base_fare: 8000, night_surcharge: 0, holiday_surcharge: 0, total: 8000, commission: 640, currency: 'COP' },
          exp: Math.floor(Date.now() / 1000) + 120,
        }),
      ).toString('base64url');
      const signature = createHmac('sha256', QUOTE_SECRET).update(body).digest().toString('base64url');

      const res = await http
        .post('/trips')
        .set('Authorization', rider.auth)
        .send({ ...quoteBody(m.municipalityId, m.center), payment_method: 'cash', quote_token: `${body}.${signature}` });

      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ code: 'QUOTE_EXPIRED' });
    });

    it('un municipio sin empresas que ofrezcan el servicio responde 409 NO_COMPANY_AVAILABLE al cotizar', async () => {
      const center = centerOf(25);
      const municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, center);
      const rider = await passenger();

      const res = await http.post('/trips/quote').set('Authorization', rider.auth).send(quoteBody(municipalityId, center));

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'NO_COMPANY_AVAILABLE' });
    });
  });
});

suite('HU-MS-16 · Cootrayal sola en su municipio: el comportamiento y los reportes no cambian (ADR-032 §12.6)', () => {
  let world: World;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    world = await bootWorld({ keepChainListener: true });
    http = request(world.app.getHttpServer());
  });

  afterAll(async () => {
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, `${PREFIX}Pilot`);
      await world.app.close();
    }
  });

  it('pedir sin elegir empresa -> oferta automática al único conductor -> aceptar -> completar; la comisión y los reportes son los de siempre', async () => {
    const center = { lat: 14.05, lng: -69.15 };
    const municipalityId = await createCoveredMunicipality(world.prisma, `${PREFIX}Pilot`, center);
    const company = await createOperatingCompany(world.prisma, municipalityId, { commissionPct: 8 });
    const adminId = await createAdminUser(world.prisma, company);
    const admin = adminAuth(world.jwt, adminId, company);
    const driver = await createDriver(world.prisma, company, around(center, 0.001));
    const driverToken = driverAuth(world.jwt, driver.driverId, company);
    const riderId = await createFreshPassenger(world.prisma);
    const rider = passengerAuth(world.jwt, riderId);

    const catalog = await http.get('/trips/service-options').set('Authorization', rider).query(center);
    expect(catalog.body.services[0]).toMatchObject({ selection_required: false });
    expect(catalog.body.services[0].companies).toHaveLength(1);

    const body = {
      origin: place(center, 0.001, 0, 'Parque'),
      destination: place(center, 0.01, 0.005, 'Hospital'),
      municipality_id: municipalityId,
      service_type: 'taxi',
    };
    const quote = await http.post('/trips/quote').set('Authorization', rider).send(body);
    expect(quote.status).toBe(200);
    const created = await http
      .post('/trips')
      .set('Authorization', rider)
      .send({ ...body, payment_method: 'cash', quote_token: quote.body.quote_token });
    expect(created.status).toBe(201);
    const tripRequestId: number = created.body.trip_request_id;

    const row = await tripRow(world.prisma, tripRequestId);
    expect(row).toMatchObject({ requestedCompanyId: null, addressedCompanyId: company });

    let offer: { assignment_id: number } | undefined;
    for (let attempt = 0; attempt < 40 && !offer; attempt += 1) {
      const nearby = await http.get('/assignments/nearby').set('Authorization', driverToken);
      offer = nearby.body[0];
      if (!offer) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(offer).toBeDefined();

    const accepted = await http
      .post(`/assignments/${offer?.assignment_id}/accept`)
      .set('Authorization', driverToken)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.result).toBe('accepted');

    const whileAssigned = await http.get(`/trips/${tripRequestId}`).set('Authorization', rider);
    expect(whileAssigned.body.status).toBe('assigned');
    expect(whileAssigned.body.driver.company).toMatchObject({ company_id: company });
    expect(whileAssigned.body.driver.company.display_name.length).toBeGreaterThan(0);
    expect(whileAssigned.body.requested_company).toBeNull();

    for (const step of ['en-route', 'arrived', 'start']) {
      expect((await http.post(`/trips/${tripRequestId}/${step}`).set('Authorization', driverToken).send({})).status).toBe(200);
    }
    const completed = await http
      .post(`/trips/${tripRequestId}/complete`)
      .set('Authorization', driverToken)
      .send({ cash_collected: true });
    expect(completed.status).toBe(200);

    const total: number = quote.body.fare.total;
    const expectedCommission = Math.round((total * 8) / 100);
    const finished = await tripRow(world.prisma, tripRequestId);
    expect(finished.status).toBe('completed');
    expect(finished.companyId).toBe(company);
    expect(Number(finished.commission)).toBe(expectedCommission);
    expect(Number(finished.commissionPct)).toBe(8);
    expect(Number(finished.netEarnings)).toBe(total - expectedCommission);

    const today = settlementToday();
    const report = await http
      .get('/admin/reports/settlement')
      .set('Authorization', admin)
      .query({ from: addDays(today, -1), to: addDays(today, 1) });
    expect(report.status).toBe(200);
    expect(report.body.totals).toMatchObject({
      trip_count: 1,
      cash_collected: total,
      commission: expectedCommission,
      driver_net: total - expectedCommission,
    });

    const consoleList = await http.get('/ops/trip-requests').set('Authorization', admin);
    expect(consoleList.status).toBe(200);
    expect(JSON.stringify(consoleList.body)).toContain(String(tripRequestId));
  });
});
