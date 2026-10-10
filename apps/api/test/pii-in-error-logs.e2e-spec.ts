import { Writable } from 'node:stream';
import { type ArgumentsHost, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { buildLogger } from '../src/infrastructure/observability/logger.factory';
import { PinoLoggerService } from '../src/infrastructure/observability/pino-logger.service';
import { captureError, Sentry } from '../src/infrastructure/observability/sentry';
import { scrubEvent } from '../src/infrastructure/observability/scrub-event';
import { createFreshPassenger } from './support/fresh-passenger';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_F02PiiMuni';
const ADDRESS = 'Carrera 21 #14-33 Barrio La Esperanza';
const DROPOFF = 'Calle 9 Sur #4-18 Conjunto Los Almendros';
const COORDINATES = ['6.96123417', '-75.41759902', '6.97711208', '-75.40088341'];
const TRIP_SENSITIVE = [ADDRESS, DROPOFF, ...COORDINATES, 'La Esperanza', 'Los Almendros'];
const USER_SENSITIVE = ['Marcela Quintero Arboleda', 'Marcela', 'Arboleda', '3157654321', 'marcela.quintero@correo.test'];
const USER_CONSTRAINT = 'user_platform_admin_has_no_company';
const TRIP_CONSTRAINT = 'trip_request_location_purge_consistent';

interface FakeResponse {
  locals: Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

function hostFor(): ArgumentsHost {
  const res: FakeResponse = {
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const req = { method: 'POST', baseUrl: '', path: '/trips', route: { path: '/trips' } };
  return {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
}

suite('PII in database error logs and Sentry events against real Postgres (ADR-033 C-2, F-02)', () => {
  let prisma: PrismaClient;
  let municipalityId: number;
  let passengerId: number;
  let tripRequestId: number;
  let windowTripId: number;
  let windowPassengerId: number;
  const logLines: string[] = [];
  const sentryEnvelopes: string[] = [];
  const stdStreams: string[] = [];
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);

    const municipality = await prisma.municipality.create({
      data: {
        name: `${PREFIX}-${Date.now()}`,
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
    passengerId = await createFreshPassenger(prisma);
    const trip = await prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId,
        pickupAddress: ADDRESS,
        dropoffAddress: DROPOFF,
        pickupLat: 6.96123417,
        pickupLng: -75.41759902,
        dropoffLat: 6.97711208,
        dropoffLng: -75.40088341,
        fare: 8000,
        commission: 640,
        status: 'completed',
      },
    });
    tripRequestId = trip.tripRequestId;
    windowPassengerId = await createFreshPassenger(prisma);
    const windowTrip = await prisma.tripRequest.create({
      data: {
        passengerId: windowPassengerId,
        municipalityId,
        pickupAddress: ADDRESS,
        dropoffAddress: DROPOFF,
        pickupLat: 6.96123417,
        pickupLng: -75.41759902,
        dropoffLat: 6.97711208,
        dropoffLng: -75.40088341,
        fare: 8000,
        commission: 640,
        status: 'driver_en_route',
      },
    });
    windowTripId = windowTrip.tripRequestId;

    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    Logger.overrideLogger(
      new PinoLoggerService(buildLogger({ level: 'debug', service: 'api', env: 'test' }, destination)),
    );
    Sentry.init({
      dsn: 'https://publickey@o0.ingest.sentry.io/1',
      sendDefaultPii: false,
      beforeSend: scrubEvent,
      transport: () => ({
        send: async (envelope) => {
          sentryEnvelopes.push(JSON.stringify(envelope));
          return {};
        },
        flush: async () => true,
      }),
    });
  });

  beforeEach(() => {
    logLines.length = 0;
    sentryEnvelopes.length = 0;
    stdStreams.length = 0;
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdStreams.push(String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stdStreams.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  afterAll(async () => {
    Logger.overrideLogger(false);
    await Sentry.close(1000);
    await prisma.tripRequest.deleteMany({ where: { passengerId: { in: [passengerId, windowPassengerId] } } });
    await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);
    await prisma.$disconnect();
  });

  async function capture(operation: () => Promise<unknown>): Promise<Error> {
    try {
      await operation();
    } catch (error) {
      return error as Error;
    }
    throw new Error('the constraint did not fire');
  }

  const violateTripRaw = (): Promise<Error> =>
    capture(
      () =>
        prisma.$executeRaw`UPDATE trips.trip_request SET location_purged_at = now() WHERE trip_request_id = ${tripRequestId}`,
    );

  const violateTripClient = (): Promise<Error> =>
    capture(() =>
      prisma.tripRequest.update({ where: { tripRequestId }, data: { locationPurgedAt: new Date() } }),
    );

  const violateUserClient = (): Promise<Error> =>
    capture(() =>
      prisma.user.create({
        data: {
          firstName: 'Marcela',
          lastName: 'Arboleda',
          phone: '3157654321',
          email: 'marcela.quintero@correo.test',
          role: 'platform_admin',
          companyId: 1,
        },
      }),
    );

  async function runThroughFilterAndSentry(error: unknown): Promise<void> {
    new AllExceptionsFilter().catch(error, hostFor());
    captureError(error);
    await Sentry.flush(2000);
  }

  function expectNone(output: string, values: readonly string[]): void {
    for (const value of values) expect(output).not.toContain(value);
  }

  const scenarios: ReadonlyArray<
    readonly [string, () => Promise<Error>, readonly string[], string | undefined, string]
  > = [
    ['trip_request through a raw query', violateTripRaw, TRIP_SENSITIVE, 'P2010', TRIP_CONSTRAINT],
    ['trip_request through the client', violateTripClient, TRIP_SENSITIVE, undefined, TRIP_CONSTRAINT],
    ['auth.user through the client', violateUserClient, USER_SENSITIVE, undefined, USER_CONSTRAINT],
  ];

  it('PostgreSQL puts the personal data in the raw error of a table without RLS (precondition)', async () => {
    const error = await violateUserClient();

    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).toContain('Failing row contains');
    expect(serialized).toContain('3157654321');
    expect(serialized).toContain('marcela.quintero@correo.test');
  });

  it.each(scenarios)(
    'leaves no personal data in the logs, Sentry or the console for %s',
    async (_name, violate, sensitive) => {
      const error = await violate();

      await runThroughFilterAndSentry(error);

      const logs = logLines.join('');
      const sentry = sentryEnvelopes.join('');
      expect(logs).toContain('unhandled_error');
      expect(sentry.length).toBeGreaterThan(0);
      expectNone(logs, sensitive);
      expectNone(sentry, sensitive);
      expectNone(stdStreams.join(''), sensitive);
    },
  );

  it.each(scenarios)(
    'logs only the Prisma code, the SQLSTATE and the constraint name for %s',
    async (_name, violate, _sensitive, prismaCode, constraint) => {
      await runThroughFilterAndSentry(await violate());

      const entry = JSON.parse(
        logLines.find((line) => line.includes('unhandled_error')) ?? '{}',
      ) as Record<string, unknown>;
      expect(entry.prisma_code).toBe(prismaCode);
      expect(entry).toMatchObject({ sqlstate: '23514', constraint });
      expect(entry).not.toHaveProperty('stack');
      expect(entry).not.toHaveProperty('meta');
      expect(entry).not.toHaveProperty('message');
    },
  );

  it('redacts the failing row when a service logs the raw error object, its message or its stack', async () => {
    const error = await violateUserClient();
    const logger = new Logger('Service');

    logger.error({ msg: 'insert_failed', err: error });
    logger.error({ msg: 'insert_failed', nested: { cause: error } });
    logger.error(`insert failed: ${error.message}`);
    logger.error(error.message, error.stack);

    expect(error.message).toContain('Failing row contains');
    expect(logLines.length).toBe(4);
    expectNone(logLines.join(''), USER_SENSITIVE);
  });

  it('scrubs the failing row from a Sentry event that carries the raw error and its message as extra', async () => {
    const error = await violateUserClient();

    Sentry.captureException(error, { extra: { detail: error.message, phone: '3157654321' } });
    await Sentry.flush(2000);

    expect(sentryEnvelopes.length).toBeGreaterThan(0);
    expectNone(sentryEnvelopes.join(''), USER_SENSITIVE);
  });

  it('leaves no start code, address or coordinate when a CHECK fails on a trip that holds a live code (ADR-033 C-2)', async () => {
    const rows = await prisma.$queryRaw<Array<{ start_code: string }>>`
      SELECT start_code FROM trips.trip_request WHERE trip_request_id = ${windowTripId}`;
    const code = rows[0]?.start_code ?? '';
    expect(code).toMatch(/^[0-9]{4}$/);
    const error = await capture(
      () =>
        prisma.$executeRaw`UPDATE trips.trip_request SET start_code_failed_attempts = 6 WHERE trip_request_id = ${windowTripId}`,
    );
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).toContain('trip_request_start_code_attempts');

    await runThroughFilterAndSentry(error);

    const outputs = [logLines.join(''), sentryEnvelopes.join(''), stdStreams.join('')];
    for (const output of outputs) {
      expectNone(output, TRIP_SENSITIVE);
      expect(output).not.toContain(`'${code}'`);
      expect(output).not.toContain(`"${code}"`);
      expect(output).not.toContain(`, ${code},`);
    }
    const entry = JSON.parse(logLines.find((line) => line.includes('unhandled_error')) ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({ sqlstate: '23514', constraint: 'trip_request_start_code_attempts' });
  });
});
