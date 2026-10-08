import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { createFreshPassenger } from './support/fresh-passenger';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_B2Settle';
const STAMP = Date.now();
const SETTLEMENT = '/admin/reports/settlement';
const WEEK_BASE = '2026-09-07';
const WEEK_BASE_END = '2026-09-13';
const EDGE_WEEK = '2026-09-21';
const FORMULA_WEEK = '2026-11-02';
const REMIT_WEEK = '2026-10-05';
const NOW_FINISHED = (day: string): Date => new Date(`${day}T17:00:00Z`);

interface DriverFixture {
  driverId: number;
  nationalId: string;
  name: string;
  plate: string;
}

interface TripSeed {
  companyId: number;
  driver: DriverFixture;
  fare: number;
  commission: number;
  finishedAt: Date;
  collected: boolean;
  assignmentStatus?: 'completed' | 'accepted';
}

function binary(
  res: NodeJS.ReadableStream,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

suite('Settlement report, CSV export and remittances as app_voyya (ADR-027)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let raw: PrismaClient;
  let jwt: JwtService;
  let municipalityId: number;
  let companyA: number;
  let companyB: number;
  let adminA: number;
  let adminB: number;
  let passengerId: number;
  let tokenAdminA: string;
  let tokenAdminB: string;
  let counter = 0;
  const drivers: Record<string, DriverFixture> = {};

  const sign = (sub: number, role: string, companyId?: number): string =>
    `Bearer ${jwt.sign({ sub, role, type: 'access', ...(companyId ? { company_id: companyId } : {}) })}`;

  async function createDriver(
    companyId: number,
    label: string,
    firstName = '_B2',
  ): Promise<DriverFixture> {
    counter += 1;
    const user = await prisma.user.create({
      data: {
        firstName,
        lastName: label,
        phone: `_b2-${STAMP}-${counter}`,
        role: 'driver',
        companyId,
      },
    });
    const plate = `_B2${counter}`;
    const nationalId = `_b2-${STAMP}-${counter}`;
    await prisma.runInTenant(companyId, async (tx) => {
      const vehicle = await tx.vehicle.create({ data: { companyId, plate, status: 'active' } });
      await tx.driver.create({
        data: {
          driverId: user.userId,
          companyId,
          nationalId,
          pin: 'x',
          currentVehicleId: vehicle.vehicleId,
        },
      });
    });
    return { driverId: user.userId, nationalId, name: `${firstName} ${label}`, plate };
  }

  async function seedTrip(seed: TripSeed): Promise<number> {
    const trip = await prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'A',
        dropoffAddress: 'B',
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: seed.fare,
        commission: seed.commission,
        status: 'completed',
        finishedAt: seed.finishedAt,
        cashCollectedAt: seed.collected ? seed.finishedAt : null,
        netEarnings: seed.collected ? seed.fare - seed.commission : null,
      },
    });
    await prisma.runInTenant(seed.companyId, async (tx) => {
      const driver = await tx.driver.findUniqueOrThrow({ where: { driverId: seed.driver.driverId } });
      await tx.assignment.create({
        data: {
          tripRequestId: trip.tripRequestId,
          driverId: seed.driver.driverId,
          vehicleId: driver.currentVehicleId as number,
          companyId: seed.companyId,
          status: seed.assignmentStatus ?? 'completed',
        },
      });
    });
    return trip.tripRequestId;
  }

  const get = (path: string, token = tokenAdminA, query: Record<string, string> = {}) =>
    request(app.getHttpServer()).get(path).query(query).set('Authorization', token);

  const post = (path: string, token: string, body?: object) =>
    request(app.getHttpServer()).post(path).set('Authorization', token).send(body);

  const week = (from: string, to: string, extra: Record<string, string> = {}) => ({
    from,
    to,
    ...extra,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    raw = prisma;
    jwt = moduleRef.get(JwtService, { strict: false });

    await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);
    const municipality = await prisma.municipality.create({
      data: {
        name: `${PREFIX}-${STAMP}`,
        department: 'Test',
        coveragePolygon: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0],
            ],
          ],
        },
        status: 'active',
      },
    });
    municipalityId = municipality.municipalityId;
    const a = await prisma.company.create({
      data: {
        legalName: 'Cooperativa Ñandú & Co.',
        taxId: `_b2-a-${STAMP}`,
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    const b = await prisma.company.create({
      data: {
        legalName: '_B2 Empresa B',
        taxId: `_b2-b-${STAMP}`,
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyA = a.companyId;
    companyB = b.companyId;
    const userA = await prisma.user.create({
      data: { firstName: 'Ana', lastName: 'Admin', phone: `_b2-admin-a-${STAMP}`, role: 'admin', companyId: companyA },
    });
    const userB = await prisma.user.create({
      data: { firstName: 'Beto', lastName: 'Admin', phone: `_b2-admin-b-${STAMP}`, role: 'admin', companyId: companyB },
    });
    adminA = userA.userId;
    adminB = userB.userId;
    tokenAdminA = sign(adminA, 'admin', companyA);
    tokenAdminB = sign(adminB, 'admin', companyB);
    passengerId = await createFreshPassenger(prisma);

    drivers.x = await createDriver(companyA, 'X');
    drivers.y = await createDriver(companyB, 'Y');
    drivers.edge = await createDriver(companyA, 'Edge');
    drivers.remit = await createDriver(companyA, 'Remit');
    drivers.race = await createDriver(companyA, 'Race');
    drivers.empty = await createDriver(companyA, 'Empty');
    drivers.pendingOnly = await createDriver(companyA, 'PendingOnly');

    const base = NOW_FINISHED('2026-09-09');
    for (const [fare, commission] of [
      [8000, 640],
      [10000, 800],
      [12000, 960],
    ] as const) {
      await seedTrip({ companyId: companyA, driver: drivers.x!, fare, commission, finishedAt: base, collected: true });
    }
    await seedTrip({ companyId: companyA, driver: drivers.x!, fare: 7000, commission: 560, finishedAt: base, collected: false });
    await seedTrip({
      companyId: companyA,
      driver: drivers.x!,
      fare: 9999,
      commission: 999,
      finishedAt: base,
      collected: true,
      assignmentStatus: 'accepted',
    });
    for (const _ of [1, 2]) {
      await seedTrip({ companyId: companyB, driver: drivers.y!, fare: 20000, commission: 1600, finishedAt: base, collected: true });
    }
    await seedTrip({ companyId: companyA, driver: drivers.pendingOnly!, fare: 6000, commission: 480, finishedAt: NOW_FINISHED('2026-09-30'), collected: false });

    const edgeTrips: Array<[string, number]> = [
      ['2026-09-21T04:59:59Z', 1000],
      ['2026-09-21T05:00:00Z', 2000],
      ['2026-09-28T04:59:59Z', 3000],
      ['2026-09-28T05:00:00Z', 4000],
    ];
    for (const [at, commission] of edgeTrips) {
      await seedTrip({ companyId: companyA, driver: drivers.edge!, fare: commission * 10, commission, finishedAt: new Date(at), collected: true });
    }

    const remitDay = NOW_FINISHED('2026-10-07');
    await seedTrip({ companyId: companyA, driver: drivers.remit!, fare: 10000, commission: 1000, finishedAt: remitDay, collected: true });
    await seedTrip({ companyId: companyA, driver: drivers.remit!, fare: 14000, commission: 1400, finishedAt: remitDay, collected: true });
    await seedTrip({ companyId: companyA, driver: drivers.race!, fare: 10000, commission: 900, finishedAt: remitDay, collected: true });
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (raw) await purgeMunicipalitiesByNamePrefix(raw, PREFIX);
  }, 60_000);

  describe('report (HU-SET-01)', () => {
    it('computes the numeric example from the recorded values and keeps pending cash apart', async () => {
      const res = await get(SETTLEMENT, tokenAdminA, week(WEEK_BASE, WEEK_BASE_END));
      expect(res.status).toBe(200);
      const row = res.body.rows.find((r: { driver_id: number }) => r.driver_id === drivers.x!.driverId);
      expect(row).toMatchObject({
        driver_name: drivers.x!.name,
        national_id: drivers.x!.nationalId,
        plate: drivers.x!.plate,
        trip_count: 3,
        cash_collected: 30000,
        commission: 2400,
        driver_net: 27600,
        amount_to_remit: 2400,
        pending_cash_trip_count: 1,
        pending_cash_amount: 7000,
      });
      expect(res.body).toMatchObject({
        from: WEEK_BASE,
        to: WEEK_BASE_END,
        time_zone: 'America/Bogota',
        week_start: WEEK_BASE,
        in_progress: false,
      });
    });

    it('totals are exactly the sum of the rows and driver_net matches the trips net earnings', async () => {
      const res = await get(SETTLEMENT, tokenAdminA, week(WEEK_BASE, WEEK_BASE_END));
      const rows: Array<Record<string, number>> = res.body.rows;
      for (const key of ['trip_count', 'cash_collected', 'commission', 'driver_net', 'amount_to_remit', 'pending_cash_trip_count', 'pending_cash_amount']) {
        expect(res.body.totals[key]).toBe(rows.reduce((total, r) => total + (r[key] ?? 0), 0));
      }
      const net = await prisma.runInTenant(companyA, (tx) => tx.$queryRaw<Array<{ net: bigint }>>`
        SELECT COALESCE(SUM(t.net_earnings), 0)::bigint AS net
          FROM assignment.assignment a
          JOIN trips.trip_request t ON t.trip_request_id = a.trip_request_id
         WHERE a.driver_id = ${drivers.x!.driverId} AND a.status = 'completed'
           AND t.status = 'completed' AND t.cash_collected_at IS NOT NULL
      `);
      const xRow = rows.find((r) => r.driver_id === drivers.x!.driverId)!;
      expect(Number(net[0]!.net)).toBe(xRow.driver_net);
    });

    it('uses the commission stored on each trip even if the company percentage changes later', async () => {
      await prisma.runInTenant(companyA, (tx) =>
        tx.fareConfig.create({
          data: { companyId: companyA, baseFare: 8000, commissionPct: 50, createdBy: adminA },
        }),
      );
      const res = await get(SETTLEMENT, tokenAdminA, week(WEEK_BASE, WEEK_BASE_END, { driver_id: String(drivers.x!.driverId) }));
      expect(res.body.rows[0].commission).toBe(2400);
    });

    it('does not count an assignment that is not completed', async () => {
      const res = await get(SETTLEMENT, tokenAdminA, week(WEEK_BASE, WEEK_BASE_END, { driver_id: String(drivers.x!.driverId) }));
      expect(res.body.rows[0].trip_count).toBe(3);
    });

    it('shows a driver with only pending cash with zero totals and the pending amount', async () => {
      const res = await get(SETTLEMENT, tokenAdminA, week('2026-09-28', '2026-10-04', { driver_id: String(drivers.pendingOnly!.driverId) }));
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0]).toMatchObject({
        trip_count: 0,
        cash_collected: 0,
        commission: 0,
        amount_to_remit: 0,
        pending_cash_trip_count: 1,
        pending_cash_amount: 6000,
      });
    });

    it('returns no rows for a driver without trips in the range and for an empty range', async () => {
      const filtered = await get(SETTLEMENT, tokenAdminA, week(WEEK_BASE, WEEK_BASE_END, { driver_id: String(drivers.empty!.driverId) }));
      expect(filtered.body.rows).toEqual([]);
      const none = await get(SETTLEMENT, tokenAdminA, week('2025-01-06', '2025-01-12'));
      expect(none.body.rows).toEqual([]);
      expect(none.body.totals.amount_to_remit).toBe(0);
    });

    it('splits trips at Monday 00:00 and Sunday 23:59 in Bogota', async () => {
      const filter = { driver_id: String(drivers.edge!.driverId) };
      const previous = await get(SETTLEMENT, tokenAdminA, week('2026-09-14', '2026-09-20', filter));
      const current = await get(SETTLEMENT, tokenAdminA, week(EDGE_WEEK, '2026-09-27', filter));
      const next = await get(SETTLEMENT, tokenAdminA, week('2026-09-28', '2026-10-04', filter));
      expect(previous.body.rows[0]).toMatchObject({ trip_count: 1, commission: 1000 });
      expect(current.body.rows[0]).toMatchObject({ trip_count: 2, commission: 5000 });
      expect(next.body.rows[0]).toMatchObject({ trip_count: 1, commission: 4000 });
    });

    it('accepts a 31 day range and rejects 32 days, inverted ranges and impossible dates', async () => {
      expect((await get(SETTLEMENT, tokenAdminA, week('2026-01-01', '2026-01-31'))).status).toBe(200);
      const tooLong = await get(SETTLEMENT, tokenAdminA, week('2026-01-01', '2026-02-01'));
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.code).toBe('INVALID_DATA');
      expect((await get(SETTLEMENT, tokenAdminA, week('2026-02-01', '2026-01-01'))).status).toBe(400);
      expect((await get(SETTLEMENT, tokenAdminA, week('2026-02-30', '2026-03-01'))).status).toBe(400);
      expect((await get(SETTLEMENT, tokenAdminA, {})).status).toBe(400);
    });

    it('two companies in the same municipality never see each other', async () => {
      const a = await get(SETTLEMENT, tokenAdminA, week(WEEK_BASE, WEEK_BASE_END));
      const b = await get(SETTLEMENT, tokenAdminB, week(WEEK_BASE, WEEK_BASE_END));
      const idsA = a.body.rows.map((r: { driver_id: number }) => r.driver_id);
      expect(idsA).not.toContain(drivers.y!.driverId);
      expect(b.body.rows.map((r: { driver_id: number }) => r.driver_id)).toEqual([drivers.y!.driverId]);
      expect(b.body.totals).toMatchObject({ trip_count: 2, cash_collected: 40000, commission: 3200 });
      const crossFilter = await get(SETTLEMENT, tokenAdminA, week(WEEK_BASE, WEEK_BASE_END, { driver_id: String(drivers.y!.driverId) }));
      expect(crossFilter.body.rows).toEqual([]);
    });
  });

  describe('CSV export (HU-SET-02)', () => {
    async function exportCsv(query: Record<string, string>, token = tokenAdminA) {
      return request(app.getHttpServer())
        .get(`${SETTLEMENT}/export`)
        .query(query)
        .set('Authorization', token)
        .buffer(true)
        .parse(binary);
    }

    it('writes UTF-8 with BOM, semicolons, header block, totals and the download headers', async () => {
      const res = await exportCsv(week(WEEK_BASE, WEEK_BASE_END));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="conciliacion_cooperativa-nandu-co_${WEEK_BASE}_${WEEK_BASE_END}.csv"`,
      );
      const body = res.body as Buffer;
      expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = body.toString('utf8').replace(/^﻿/, '');
      expect(text).not.toMatch(/sep=/);
      const lines = text.split('\r\n');
      expect(lines.slice(0, 4)).toEqual([
        'Empresa;Cooperativa Ñandú & Co.',
        `Desde;${WEEK_BASE}`,
        `Hasta;${WEEK_BASE_END}`,
        'Zona horaria;America/Bogota',
      ]);
      expect(lines[4]).toMatch(/^Generado;\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(hora Bogotá\)$/);
      expect(lines[5]).toBe('');
      expect(lines[6]).toBe(
        'Conductor;Cédula;Placa;Viajes;Efectivo cobrado;Comisión registrada;Neto del conductor;Total a remitir;Viajes con cobro pendiente;Monto con cobro pendiente',
      );
      expect(lines).toContain(
        `${drivers.x!.name};${drivers.x!.nationalId};${drivers.x!.plate};3;30000;2400;27600;2400;1;7000`,
      );
      expect(lines.find((l) => l.startsWith('Totales;;;'))).toBe('Totales;;;3;30000;2400;27600;2400;1;7000');
    });

    it('neutralizes names that start with a formula character', async () => {
      const chars = ['=', '+', '-', '@'];
      for (const char of chars) {
        const driver = await createDriver(companyA, `Formula${chars.indexOf(char)}`, `${char}CMD`);
        await seedTrip({ companyId: companyA, driver, fare: 5000, commission: 400, finishedAt: NOW_FINISHED(FORMULA_WEEK), collected: true });
      }
      const res = await exportCsv(week(FORMULA_WEEK, '2026-11-08'));
      const text = (res.body as Buffer).toString('utf8');
      for (const char of chars) expect(text).toContain(`\r\n'${char}CMD Formula${chars.indexOf(char)};`);
      for (const char of chars) expect(text).not.toContain(`\r\n${char}CMD`);
    });

    it('records each export with who, when, range and row count, without names or national ids', async () => {
      const before = await prisma.runInTenant(companyA, (tx) => tx.settlementExport.count());
      const filter = { driver_id: String(drivers.x!.driverId) };
      await exportCsv(week(WEEK_BASE, WEEK_BASE_END, filter));
      const rows = await prisma.runInTenant(companyA, (tx) =>
        tx.settlementExport.findMany({ orderBy: { exportId: 'desc' }, take: 1 }),
      );
      expect(await prisma.runInTenant(companyA, (tx) => tx.settlementExport.count())).toBe(before + 1);
      expect(rows[0]).toMatchObject({
        companyId: companyA,
        exportedBy: adminA,
        driverId: drivers.x!.driverId,
        rowCount: 1,
      });
      expect(rows[0]!.fromDate.toISOString().slice(0, 10)).toBe(WEEK_BASE);
      expect(rows[0]!.toDate.toISOString().slice(0, 10)).toBe(WEEK_BASE_END);
      expect(JSON.stringify(rows[0])).not.toContain(drivers.x!.nationalId);
      expect(await prisma.runInTenant(companyB, (tx) => tx.settlementExport.count())).toBe(0);
    });

    it('does not export or audit when the range is invalid', async () => {
      const before = await prisma.runInTenant(companyA, (tx) => tx.settlementExport.count());
      const res = await exportCsv(week('2026-01-01', '2026-02-05'));
      expect(res.status).toBe(400);
      expect(await prisma.runInTenant(companyA, (tx) => tx.settlementExport.count())).toBe(before);
    });
  });

  describe('remittances (HU-SET-03)', () => {
    const remittances = `${SETTLEMENT}/remittances`;
    const entries: { first?: number; second?: number; reversal?: number } = {};

    const record = (driverId: number, expected: number, token = tokenAdminA, weekStart = REMIT_WEEK) =>
      post(remittances, token, { driver_id: driverId, week_start: weekStart, expected_amount: expected });

    const remitReport = (driverId: number) =>
      get(SETTLEMENT, tokenAdminA, week(REMIT_WEEK, '2026-10-11', { driver_id: String(driverId) }));

    it('rejects a body that is not a Monday week or has a non positive amount', async () => {
      expect((await record(drivers.remit!.driverId, 2400, tokenAdminA, '2026-10-06')).status).toBe(400);
      expect((await record(drivers.remit!.driverId, 0)).status).toBe(400);
    });

    it('registers the remittance with the balance and answers 404 for a driver of another company', async () => {
      const res = await record(drivers.remit!.driverId, 2400);
      expect(res.status).toBe(200);
      expect(res.body.idempotent).toBe(false);
      expect(res.body.entry).toMatchObject({
        driver_id: drivers.remit!.driverId,
        week_start: REMIT_WEEK,
        kind: 'remittance',
        amount: 2400,
        reverses_remittance_id: null,
        reversed: false,
        recorded_by: { user_id: adminA, name: 'Ana Admin' },
      });
      expect(res.body.summary).toMatchObject({ remitted_amount: 2400, balance: 0 });
      entries.first = res.body.entry.remittance_id;

      const foreign = await record(drivers.y!.driverId, 3200);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('DRIVER_NOT_FOUND');
    });

    it('is idempotent: the second mark returns the same entry and does not insert', async () => {
      const res = await record(drivers.remit!.driverId, 2400);
      expect(res.status).toBe(200);
      expect(res.body.idempotent).toBe(true);
      expect(res.body.entry.remittance_id).toBe(entries.first);
      const history = await get(remittances, tokenAdminA, { driver_id: String(drivers.remit!.driverId) });
      expect(history.body.rows).toHaveLength(1);
    });

    it('serializes two simultaneous marks into one insert', async () => {
      const [one, two] = await Promise.all([
        record(drivers.race!.driverId, 900),
        record(drivers.race!.driverId, 900),
      ]);
      expect([one.status, two.status]).toEqual([200, 200]);
      expect([one.body.idempotent, two.body.idempotent].sort()).toEqual([false, true]);
      expect(one.body.entry.remittance_id).toBe(two.body.entry.remittance_id);
      const history = await get(remittances, tokenAdminA, { driver_id: String(drivers.race!.driverId) });
      expect(history.body.rows).toHaveLength(1);
    });

    it('shows the remitted amount and the balance after a late cash collection', async () => {
      const lateTrip = await seedTrip({
        companyId: companyA,
        driver: drivers.remit!,
        fare: 8000,
        commission: 800,
        finishedAt: NOW_FINISHED('2026-10-08'),
        collected: false,
      });
      const before = await remitReport(drivers.remit!.driverId);
      expect(before.body.rows[0].amount_to_remit).toBe(2400);
      expect(before.body.rows[0].pending_cash_trip_count).toBe(1);

      await raw.$executeRaw`UPDATE trips.trip_request SET cash_collected_at = finished_at WHERE trip_request_id = ${lateTrip}`;
      const after = await remitReport(drivers.remit!.driverId);
      expect(after.body.rows[0]).toMatchObject({
        amount_to_remit: 3200,
        remittance: { remitted_amount: 2400, balance: 800 },
      });
      expect(after.body.totals).toMatchObject({ remitted_amount: 2400, remittance_balance: 800 });
      expect(after.body.rows[0].remittance.last_remitted_at).toEqual(expect.any(String));
    });

    it('answers SETTLEMENT_BALANCE_CHANGED for a stale expected amount and marks the new balance', async () => {
      const stale = await record(drivers.remit!.driverId, 2400);
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        code: 'SETTLEMENT_BALANCE_CHANGED',
        message: 'El saldo cambió. Vuelve a generar el reporte.',
      });

      const res = await record(drivers.remit!.driverId, 800);
      expect(res.status).toBe(200);
      expect(res.body.idempotent).toBe(false);
      expect(res.body.entry.amount).toBe(800);
      expect(res.body.summary).toMatchObject({ remitted_amount: 3200, balance: 0 });
      entries.second = res.body.entry.remittance_id;
    });

    it('reverses once, without deleting, and a second reversal returns the same one idempotently', async () => {
      const res = await post(`${remittances}/${entries.second}/reversal`, tokenAdminA);
      expect(res.status).toBe(200);
      expect(res.body.idempotent).toBe(false);
      expect(res.body.entry).toMatchObject({
        kind: 'reversal',
        amount: 800,
        reverses_remittance_id: entries.second,
        reversed: false,
      });
      expect(res.body.summary).toMatchObject({ remitted_amount: 2400, balance: 800 });
      entries.reversal = res.body.entry.remittance_id;

      const again = await post(`${remittances}/${entries.second}/reversal`, tokenAdminA);
      expect(again.status).toBe(200);
      expect(again.body.idempotent).toBe(true);
      expect(again.body.entry.remittance_id).toBe(entries.reversal);

      const history = await get(remittances, tokenAdminA, { driver_id: String(drivers.remit!.driverId), week_start: REMIT_WEEK });
      expect(history.body.rows.map((r: { remittance_id: number }) => r.remittance_id)).toEqual(
        expect.arrayContaining([entries.first, entries.second, entries.reversal]),
      );
      expect(history.body.rows).toHaveLength(3);
      const reversed = history.body.rows.find((r: { remittance_id: number }) => r.remittance_id === entries.second);
      expect(reversed.reversed).toBe(true);
    });

    it('refuses to reverse a reversal and answers 404 for unknown or foreign entries', async () => {
      const reversal = await post(`${remittances}/${entries.reversal}/reversal`, tokenAdminA);
      expect(reversal.status).toBe(409);
      expect(reversal.body.code).toBe('REMITTANCE_NOT_REVERSIBLE');

      const unknown = await post(`${remittances}/999999999/reversal`, tokenAdminA);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('REMITTANCE_NOT_FOUND');

      const foreign = await post(`${remittances}/${entries.first}/reversal`, tokenAdminB);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('REMITTANCE_NOT_FOUND');
    });

    it('answers NOTHING_TO_REMIT when there is no commission to remit', async () => {
      const res = await record(drivers.empty!.driverId, 100);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOTHING_TO_REMIT');
    });

    it('does not let another company read or write the history', async () => {
      const history = await get(remittances, tokenAdminB, { driver_id: String(drivers.remit!.driverId) });
      expect(history.status).toBe(200);
      expect(history.body.rows).toEqual([]);
      expect((await get(remittances, tokenAdminA, {})).status).toBe(400);
    });

    it('cannot be updated or deleted by the application role', async () => {
      await expect(
        prisma.runInTenant(companyA, (tx) =>
          tx.$executeRaw`UPDATE admin.settlement_remittance SET amount = 1 WHERE remittance_id = ${entries.first}`,
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.runInTenant(companyA, (tx) =>
          tx.$executeRaw`DELETE FROM admin.settlement_remittance WHERE remittance_id = ${entries.first}`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('roles', () => {
    const calls: Array<[string, string, string]> = [
      ['GET', SETTLEMENT, 'report'],
      ['GET', `${SETTLEMENT}/export`, 'export'],
      ['GET', `${SETTLEMENT}/remittances`, 'history'],
      ['POST', `${SETTLEMENT}/remittances`, 'record'],
      ['POST', `${SETTLEMENT}/remittances/1/reversal`, 'reverse'],
    ];

    it.each([
      ['operator', () => sign(7001, 'operator', companyA)],
      ['driver', () => sign(drivers.x!.driverId, 'driver', companyA)],
      ['passenger', () => sign(passengerId, 'passenger')],
      ['platform_admin', () => sign(7002, 'platform_admin')],
    ])('answers 403 to %s on every settlement route', async (_role, token) => {
      for (const [method, path] of calls) {
        const req =
          method === 'GET'
            ? request(app.getHttpServer()).get(path).query(week(WEEK_BASE, WEEK_BASE_END))
            : request(app.getHttpServer()).post(path).send({});
        const res = await req.set('Authorization', token());
        expect([path, res.status]).toEqual([path, 403]);
      }
    });

    it('answers 401 without a session', async () => {
      const res = await request(app.getHttpServer()).get(SETTLEMENT).query(week(WEEK_BASE, WEEK_BASE_END));
      expect(res.status).toBe(401);
    });
  });
});
