import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type {
  AssignmentCancelledByDriverEvent,
  DriverAssignedEvent,
  TripRequestDriverArrivedEvent,
  TripRequestNoDriverEvent,
} from '@voyyaa/shared';
import { EnvService } from '../../../config/env.service';
import { PUSH_TRANSPORT } from '../ports/push-transport.port';
import { RecordingPushTransport } from '../recording-push-transport.fixture';
import {
  expectedPassengerPushMessage,
  leakedTerms,
  SEEDED_IDS,
  SEEDED_REASON,
  SEEDED_TRIP_REQUEST_ID,
  SEEDED_TTL_SEC,
} from './passenger-push.fixture';
import { PassengerPushLedger } from './passenger-push.ledger';
import { PassengerTripPushListener } from './passenger-trip-push.listener';

const TRIP = SEEDED_TRIP_REQUEST_ID;
const NOW = '2026-10-13T12:00:00.000Z';

function driverAssigned(over: Partial<DriverAssignedEvent> = {}): DriverAssignedEvent {
  return {
    trip_request_id: TRIP,
    passenger_id: SEEDED_IDS.passengerId,
    assignment_id: SEEDED_IDS.assignmentId,
    driver_id: SEEDED_IDS.driverId,
    vehicle_id: 3,
    company_id: SEEDED_IDS.companyId,
    occurred_at: NOW,
    ...over,
  };
}

function driverCancelled(
  status: AssignmentCancelledByDriverEvent['trip_request_status'],
  over: Partial<AssignmentCancelledByDriverEvent> = {},
): AssignmentCancelledByDriverEvent {
  return {
    assignment_id: SEEDED_IDS.assignmentId,
    trip_request_id: TRIP,
    passenger_id: SEEDED_IDS.passengerId,
    driver_id: SEEDED_IDS.driverId,
    reason: SEEDED_REASON,
    trip_request_status: status,
    occurred_at: NOW,
    ...over,
  };
}

function driverArrived(): TripRequestDriverArrivedEvent {
  return {
    trip_request_id: TRIP,
    passenger_id: SEEDED_IDS.passengerId,
    driver_id: SEEDED_IDS.driverId,
    company_id: SEEDED_IDS.companyId,
    arrived_at: NOW,
    occurred_at: NOW,
  };
}

function noDriver(): TripRequestNoDriverEvent {
  return {
    trip_request_id: TRIP,
    passenger_id: SEEDED_IDS.passengerId,
    attempts_made: 3,
    final_radius_km: 5,
    occurred_at: NOW,
  };
}

const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Rig {
  app: INestApplication;
  emitter: EventEmitter2;
  transport: RecordingPushTransport;
  listener: PassengerTripPushListener;
  logs: string[];
}

async function buildRig(maxPerTrip = 10): Promise<Rig> {
  const transport = new RecordingPushTransport();
  const env = {
    get: (key: string) =>
      ({ PASSENGER_PUSH_TTL_SEC: SEEDED_TTL_SEC, PASSENGER_PUSH_MAX_PER_TRIP: maxPerTrip })[
        key as 'PASSENGER_PUSH_TTL_SEC'
      ],
  };
  const moduleRef = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      PassengerTripPushListener,
      PassengerPushLedger,
      { provide: EnvService, useValue: env },
      { provide: PUSH_TRANSPORT, useValue: transport },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    emitter: moduleRef.get(EventEmitter2),
    transport,
    listener: moduleRef.get(PassengerTripPushListener),
    logs: [],
  };
}

function captureLogs(rig: Rig): () => void {
  const spies = (['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      rig.logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    }),
  );
  return () => spies.forEach((spy) => spy.mockRestore());
}

describe('PassengerTripPushListener · which fact sends which notice, and to whom (ADR-034 section 2)', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await buildRig();
  });

  afterEach(async () => {
    await rig.app.close();
  });

  it('E1: a driver accepted -> trip_driver_assigned to the passenger of the trip', async () => {
    rig.emitter.emit('assignment.driver_assigned', driverAssigned());
    await settle();

    expect(rig.transport.sent).toHaveLength(1);
    expect(rig.transport.sent[0]?.userId).toBe(SEEDED_IDS.passengerId);
    expect(rig.transport.sent[0]?.message).toEqual(expectedPassengerPushMessage('trip_driver_assigned'));
  });

  it('E2a: the driver cancelled and the search reopened -> trip_driver_cancelled_searching', async () => {
    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
    await settle();

    expect(rig.transport.sent).toHaveLength(1);
    expect(rig.transport.sent[0]?.message).toEqual(
      expectedPassengerPushMessage('trip_driver_cancelled_searching'),
    );
  });

  it('E2b: the driver cancelled and the trip ended -> trip_driver_cancelled_ended', async () => {
    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('cancelled_by_driver'));
    await settle();

    expect(rig.transport.sent).toHaveLength(1);
    expect(rig.transport.sent[0]?.message).toEqual(
      expectedPassengerPushMessage('trip_driver_cancelled_ended'),
    );
  });

  it('E3: the driver marked arrival -> trip_driver_arrived', async () => {
    rig.emitter.emit('trip_request.driver_arrived', driverArrived());
    await settle();

    expect(rig.transport.sent).toHaveLength(1);
    expect(rig.transport.sent[0]?.message).toEqual(expectedPassengerPushMessage('trip_driver_arrived'));
  });

  it('E4: the search ended without a driver (already applied) -> trip_no_driver', async () => {
    rig.emitter.emit('trip_request.no_driver', noDriver());
    await settle();

    expect(rig.transport.sent).toHaveLength(1);
    expect(rig.transport.sent[0]?.message).toEqual(expectedPassengerPushMessage('trip_no_driver'));
  });

  it('every notice goes to the passenger of the trip and never to the driver or a company', async () => {
    rig.emitter.emit('assignment.driver_assigned', driverAssigned());
    rig.emitter.emit('trip_request.driver_arrived', driverArrived());
    rig.emitter.emit('trip_request.no_driver', noDriver());
    await settle();

    const recipients = rig.transport.sent.map((record) => record.userId);
    expect(recipients).toEqual([SEEDED_IDS.passengerId, SEEDED_IDS.passengerId, SEEDED_IDS.passengerId]);
    expect(recipients).not.toContain(SEEDED_IDS.driverId);
    expect(recipients).not.toContain(SEEDED_IDS.companyId);
  });

  it('the log reference is typed by audience with the trip, the notice type and the instant of the fact', async () => {
    rig.emitter.emit('trip_request.driver_arrived', driverArrived());
    await settle();

    expect(rig.transport.sent[0]?.ref).toEqual({
      audience: 'passenger',
      tripRequestId: TRIP,
      type: 'trip_driver_arrived',
      occurredAtMs: Date.parse(NOW),
    });
  });

  it('a malformed occurred_at falls back to the receipt time instead of breaking the send', async () => {
    rig.emitter.emit('trip_request.driver_arrived', { ...driverArrived(), occurred_at: 'not a date' });
    await settle();

    const ref = rig.transport.sent[0]?.ref;
    expect(ref?.audience === 'passenger' && Number.isFinite(ref.occurredAtMs)).toBe(true);
  });

  it('a cancellation with any other trip status sends nothing', async () => {
    for (const status of ['assigned', 'driver_en_route', 'cancelled_by_passenger', 'no_driver'] as const) {
      rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled(status));
    }
    await settle();

    expect(rig.transport.sent).toEqual([]);
  });

  it.each([
    'assignment.created',
    'assignment.rejected',
    'assignment.expired',
    'assignment.search_exhausted',
    'trip_request.created',
    'trip_request.expired',
  ])('%s is not a notice: nothing is sent', async (event) => {
    rig.emitter.emit(event, { trip_request_id: TRIP, passenger_id: SEEDED_IDS.passengerId, occurred_at: NOW });
    await settle();

    expect(rig.transport.sent).toEqual([]);
  });

  it.each(['trip_request.cancelled', 'trip_request.completed', 'trip_request.no_show'])(
    '%s sends nothing and only releases the memory of the trip',
    async (event) => {
      rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
      await settle();
      rig.transport.sent.length = 0;

      rig.emitter.emit(event, { trip_request_id: TRIP, passenger_id: SEEDED_IDS.passengerId });
      rig.emitter.emit('assignment.driver_assigned', driverAssigned());
      await settle();

      expect(rig.transport.sent).toHaveLength(1);
      expect(rig.transport.sent[0]?.message.data.type).toBe('trip_driver_assigned');
    },
  );
});

describe('PassengerTripPushListener · reassignment, "new driver" (ADR-034 section 3.2, T-3)', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await buildRig();
  });

  afterEach(async () => {
    await rig.app.close();
  });

  it('E1 after an E2a of the same trip -> trip_driver_reassigned, with the same replace key as the cancellation', async () => {
    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
    rig.emitter.emit('assignment.driver_assigned', driverAssigned());
    await settle();

    expect(rig.transport.sent.map((record) => record.message.data.type)).toEqual([
      'trip_driver_cancelled_searching',
      'trip_driver_reassigned',
    ]);
    expect(rig.transport.sent[0]?.message.replaceKey).toBe(rig.transport.sent[1]?.message.replaceKey);
    expect(rig.transport.sent[1]?.message).toEqual(expectedPassengerPushMessage('trip_driver_reassigned'));
  });

  it('E1 of a trip that never had an E2a is a plain trip_driver_assigned, even if another trip had one', async () => {
    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment', { trip_request_id: 99 }));
    rig.emitter.emit('assignment.driver_assigned', driverAssigned());
    await settle();

    expect(rig.transport.sent.map((record) => record.message.data.type)).toEqual([
      'trip_driver_cancelled_searching',
      'trip_driver_assigned',
    ]);
  });

  it('E2a then E4 (no more candidates) -> both notices, in the order of the facts', async () => {
    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
    rig.emitter.emit('trip_request.no_driver', noDriver());
    await settle();

    expect(rig.transport.sent.map((record) => record.message.data.type)).toEqual([
      'trip_driver_cancelled_searching',
      'trip_no_driver',
    ]);
  });

  it('E2a and E2b are never produced by the same fact', async () => {
    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
    await settle();

    expect(rig.transport.sent.map((record) => record.message.data.type)).toEqual([
      'trip_driver_cancelled_searching',
    ]);
  });

  it('sends in series per trip: the second notice does not start until the first one finished', async () => {
    rig.transport.beforeSend = async (index) => {
      if (index === 0) await settle(40);
    };

    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
    rig.emitter.emit('assignment.driver_assigned', driverAssigned());
    await settle(10);
    expect(rig.transport.sent).toHaveLength(1);

    await settle(80);
    expect(rig.transport.sent.map((record) => record.message.data.type)).toEqual([
      'trip_driver_cancelled_searching',
      'trip_driver_reassigned',
    ]);
  });

  it('a terminal notice closes the trip memory: a later E1 of that id is a plain assignment again', async () => {
    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
    rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('cancelled_by_driver'));
    await settle();
    rig.transport.sent.length = 0;

    rig.emitter.emit('assignment.driver_assigned', driverAssigned());
    await settle();

    expect(rig.transport.sent[0]?.message.data.type).toBe('trip_driver_assigned');
  });
});

describe('PassengerTripPushListener · cap per trip (ADR-034 section 3.3, T-6)', () => {
  it('the notice after the cap is not sent and leaves a log without personal data', async () => {
    const rig = await buildRig(2);
    const restore = captureLogs(rig);
    try {
      rig.emitter.emit('trip_request.driver_arrived', driverArrived());
      rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
      rig.emitter.emit('assignment.driver_assigned', driverAssigned());
      await settle();

      expect(rig.transport.sent).toHaveLength(2);
      expect(rig.logs).toContain('[push:passenger] capped tripRequest=17 type=trip_driver_reassigned');
      expect(leakedTerms(rig.logs.join('\n'))).toEqual([]);
    } finally {
      restore();
      await rig.app.close();
    }
  });
});

describe('PassengerTripPushListener · the push never changes or delays the trip (ADR-034 section 2.5, T-5)', () => {
  let rig: Rig;
  let restore: () => void;

  beforeEach(async () => {
    rig = await buildRig();
    restore = captureLogs(rig);
  });

  afterEach(async () => {
    restore();
    await rig.app.close();
  });

  it('emit returns before the transport is even called: the listener runs on a later tick', () => {
    rig.emitter.emit('trip_request.driver_arrived', driverArrived());

    expect(rig.transport.sent).toEqual([]);
  });

  it('a transport that rejects: the handler resolves, nothing is relaunched and the log carries no error content', async () => {
    rig.transport.mode = 'reject';

    await expect(rig.listener.onDriverArrived(driverArrived())).resolves.toBeUndefined();

    expect(rig.logs).toEqual(['[push:passenger] failed tripRequest=17 type=trip_driver_arrived']);
    expect(rig.logs.join('\n')).not.toContain('push transport is down');
  });

  it('a transport that rejects does not break the next notice of the trip', async () => {
    rig.transport.mode = 'reject';
    await rig.listener.onDriverArrived(driverArrived());

    rig.transport.mode = 'record';
    await rig.listener.onNoDriver(noDriver());

    expect(rig.transport.sent.map((record) => record.message.data.type)).toEqual([
      'trip_driver_arrived',
      'trip_no_driver',
    ]);
  });

  it('a transport that never answers cannot make the event emission wait', async () => {
    rig.transport.mode = 'hang';

    const start = Date.now();
    rig.emitter.emit('assignment.driver_assigned', driverAssigned());
    rig.emitter.emit('trip_request.driver_arrived', driverArrived());
    await settle();

    expect(Date.now() - start).toBeLessThan(500);
    expect(rig.transport.sent).toHaveLength(1);
  });

  it('a ledger that fails is swallowed: the handler resolves and logs only the trip and the type', async () => {
    const broken = new PassengerTripPushListener(
      { get: () => SEEDED_TTL_SEC } as unknown as EnvService,
      {
        hadDriverCancellation: () => false,
        submit: () => {
          throw new Error('ledger exploded with 4821');
        },
        forget: () => undefined,
      } as unknown as PassengerPushLedger,
      rig.transport,
    );

    await expect(broken.onDriverAssigned(driverAssigned())).resolves.toBeUndefined();

    expect(rig.logs).toEqual(['[push:passenger] failed tripRequest=17 type=trip_driver_assigned']);
  });
});

describe('PassengerTripPushListener · the reason of the driver never reaches the notice (C-6, T-1a, T-1b, T-8)', () => {
  it('a sentinel reason on E2a and E2b is absent from the recorded sends, the transport reference and every log line', async () => {
    const rig = await buildRig();
    const restore = captureLogs(rig);
    try {
      rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
      rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('cancelled_by_driver'));
      await settle();

      expect(rig.transport.sent).toHaveLength(2);
      expect(JSON.stringify(rig.transport.sent)).not.toContain(SEEDED_REASON);
      expect(rig.logs.join('\n')).not.toContain(SEEDED_REASON);
      expect(leakedTerms(JSON.stringify(rig.transport.sent.map((record) => record.message)))).toEqual([]);
    } finally {
      restore();
      await rig.app.close();
    }
  });

  it('even when the transport fails, the sentinel is not logged', async () => {
    const rig = await buildRig();
    const restore = captureLogs(rig);
    rig.transport.mode = 'reject';
    try {
      rig.emitter.emit('assignment.cancelled_by_driver', driverCancelled('pending_assignment'));
      await settle();

      expect(rig.logs.join('\n')).not.toContain(SEEDED_REASON);
    } finally {
      restore();
      await rig.app.close();
    }
  });

  it('the cancellation handler declares a parameter type without reason (checked by the compiler, restated here)', () => {
    const handler: (fact: Omit<AssignmentCancelledByDriverEvent, 'reason' | 'driver_id' | 'assignment_id'>) => Promise<void> =
      PassengerTripPushListener.prototype.onDriverCancelled;

    expect(typeof handler).toBe('function');
  });
});

describe('PassengerTripPushListener · subscriptions', () => {
  const metadata = (method: unknown): Array<{ event: string; options?: { async?: boolean } }> =>
    (Reflect.getMetadata('EVENT_LISTENER_METADATA', method as object) ?? []) as Array<{
      event: string;
      options?: { async?: boolean };
    }>;

  const prototype = PassengerTripPushListener.prototype;

  it('the four notice handlers run asynchronously, so not even their synchronous part delays the response', () => {
    const sending = [
      prototype.onDriverAssigned,
      prototype.onDriverCancelled,
      prototype.onDriverArrived,
      prototype.onNoDriver,
    ];

    for (const handler of sending) {
      const entries = metadata(handler);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.options?.async).toBe(true);
    }
  });

  it('listens to exactly the four facts of the notices and the three terminal facts that release memory', () => {
    const events = Object.getOwnPropertyNames(prototype)
      .flatMap((name) => metadata((prototype as unknown as Record<string, unknown>)[name]))
      .map((entry) => entry.event)
      .sort();

    expect(events).toEqual(
      [
        'assignment.cancelled_by_driver',
        'assignment.driver_assigned',
        'trip_request.cancelled',
        'trip_request.completed',
        'trip_request.driver_arrived',
        'trip_request.no_driver',
        'trip_request.no_show',
      ].sort(),
    );
  });
});
