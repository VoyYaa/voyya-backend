import { Logger } from '@nestjs/common';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import type { EnvService } from '../../../config/env.service';
import {
  expectedPassengerPushMessage,
  leakedTerms,
  SEEDED_TRIP_REQUEST_ID,
} from '../passenger/passenger-push.fixture';
import type { PushLogRef, PushMessage } from '../ports/push-transport.port';
import type { PushTokenRepository } from '../push-token.repository';

interface FakeExpoState {
  tickets: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;
  sent: ExpoPushMessage[][];
  constructed: unknown[];
}

const mockExpo: FakeExpoState = {
  tickets: async (messages) => messages.map((_m, i) => ({ status: 'ok', id: `ticket-${i}` })),
  sent: [],
  constructed: [],
};

jest.mock(
  'expo-server-sdk',
  () => ({
    Expo: class {
      constructor(options: unknown) {
        mockExpo.constructed.push(options);
      }
      static isExpoPushToken(token: unknown): boolean {
        return typeof token === 'string' && /^ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]$/.test(token);
      }
      chunkPushNotifications<T>(messages: T[]): T[][] {
        return [messages];
      }
      async sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
        mockExpo.sent.push(messages);
        return mockExpo.tickets(messages);
      }
    },
  }),
);

import { ExpoPushTransport, maskToken, toExpoMessage } from './expo-push.transport';
import { toAssignmentPushMessage } from '../../assignment/providers/assignment-push.provider';

const OWNER_TOKEN = 'ExponentPushToken[ownerphoneAAAAAAAAAA]';
const SECOND_OWNER_TOKEN = 'ExponentPushToken[ownerphoneBBBBBBBBBB]';

const PASSENGER_REF: PushLogRef = {
  audience: 'passenger',
  tripRequestId: SEEDED_TRIP_REQUEST_ID,
  type: 'trip_driver_assigned',
  occurredAtMs: Date.now() - 250,
};
const DRIVER_REF: PushLogRef = { audience: 'driver', assignmentId: 42 };

const PASSENGER_MESSAGE = expectedPassengerPushMessage('trip_driver_assigned');
const DRIVER_MESSAGE = toAssignmentPushMessage({
  assignment_id: 42,
  trip_request_id: 99,
  origin: { address: 'Calle 50 #30-20, Barrio El Prado', lat: 6.9647, lng: -75.4197 },
  dropoff_neighborhood: 'El Prado',
  total_fare: 8000,
  distance_to_origin_m: 350,
  expires_at: '2026-09-25T12:00:15.000Z',
  seconds_to_respond: 15,
});

function fakeEnv(timeoutMs = 3000, nodeEnv = 'test'): EnvService {
  return {
    get: (key: string) => ({ PUSH_SEND_TIMEOUT_MS: timeoutMs, NODE_ENV: nodeEnv })[key as 'NODE_ENV'],
  } as unknown as EnvService;
}

function fakeTokens(tokens: string[] = [OWNER_TOKEN]): {
  repo: PushTokenRepository;
  listByUser: jest.Mock;
  drop: jest.Mock;
} {
  const listByUser = jest.fn(async () => tokens);
  const drop = jest.fn(async () => undefined);
  return { repo: { listByUser, drop } as unknown as PushTokenRepository, listByUser, drop };
}

function transportWith(tokens: string[] = [OWNER_TOKEN], timeoutMs = 3000) {
  const store = fakeTokens(tokens);
  return { transport: new ExpoPushTransport(fakeEnv(timeoutMs), store.repo, 'expo-access-token'), ...store };
}

function errorTicket(
  error: NonNullable<Extract<ExpoPushTicket, { status: 'error' }>['details']>['error'],
): ExpoPushTicket {
  return { status: 'error', message: error ?? 'unknown', details: { error } };
}

interface CapturedLogs {
  lines: string[];
  restore: () => void;
}

function captureLogs(): CapturedLogs {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    }),
  );
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

beforeEach(() => {
  mockExpo.sent = [];
  mockExpo.constructed = [];
  mockExpo.tickets = async (messages) => messages.map((_m, i) => ({ status: 'ok', id: `ticket-${i}` }));
});

describe('maskToken', () => {
  it('keeps only the last 6 characters', () => {
    expect(maskToken('ExponentPushToken[abcdefghij123456]')).toBe('…23456]');
  });

  it('does not mask tokens that are already short', () => {
    expect(maskToken('abcdef')).toBe('abcdef');
  });
});

describe('ExpoPushTransport · the real message handed to Expo (T-1b, ADR-034 section 4.3)', () => {
  it('a passenger message carries exactly to, title, body, data, sound, priority, channelId, ttl, tag and collapseId', async () => {
    const { transport } = transportWith();

    await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    const message = mockExpo.sent[0]?.[0];
    expect(Object.keys(message ?? {}).sort()).toEqual(
      ['body', 'channelId', 'collapseId', 'data', 'priority', 'sound', 'tag', 'title', 'to', 'ttl'].sort(),
    );
  });

  it('the values of a passenger message are exactly the ones of the contract', async () => {
    const { transport } = transportWith();

    await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    expect(mockExpo.sent[0]?.[0]).toEqual({
      to: OWNER_TOKEN,
      title: '¡Ya tienes conductor!',
      body: 'Un conductor aceptó tu viaje. Abre VoyYa para ver quién es.',
      data: { type: 'trip_driver_assigned', trip_request_id: SEEDED_TRIP_REQUEST_ID },
      sound: 'default',
      priority: 'high',
      channelId: 'trip-updates',
      ttl: 300,
      tag: `trip-${SEEDED_TRIP_REQUEST_ID}`,
      collapseId: `trip-${SEEDED_TRIP_REQUEST_ID}`,
    });
  });

  it('a passenger message to Expo never mentions anything on the forbidden list', async () => {
    const { transport } = transportWith();

    await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    expect(leakedTerms(JSON.stringify(mockExpo.sent))).toEqual([]);
  });

  it('a driver message (replaceKey null) has neither tag nor collapseId and keeps its shape from before the move', async () => {
    const { transport } = transportWith();

    await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

    const message = mockExpo.sent[0]?.[0];
    expect(Object.keys(message ?? {}).sort()).toEqual(
      ['body', 'channelId', 'data', 'priority', 'sound', 'title', 'to', 'ttl'].sort(),
    );
    expect(message).toEqual({
      to: OWNER_TOKEN,
      title: 'Nuevo viaje disponible',
      body: '$8.000 · recogida a 350 m',
      data: {
        type: 'assignment_offer',
        assignment_id: 42,
        trip_request_id: 99,
        expires_at: '2026-09-25T12:00:15.000Z',
      },
      sound: 'default',
      priority: 'high',
      channelId: 'assignment-offers',
      ttl: 15,
    });
  });

  it('sends one message per token of the owner and asks the repository only for that user', async () => {
    const { transport, listByUser } = transportWith([OWNER_TOKEN, SECOND_OWNER_TOKEN]);

    await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    expect(listByUser).toHaveBeenCalledWith(4529);
    expect(mockExpo.sent[0]?.map((m) => m.to)).toEqual([OWNER_TOKEN, SECOND_OWNER_TOKEN]);
  });

  it('the access token goes to the SDK client', () => {
    transportWith();

    expect(mockExpo.constructed).toEqual([{ accessToken: 'expo-access-token' }]);
  });

  it('toExpoMessage adds tag and collapseId only when there is a replace key', () => {
    const withoutKey: PushMessage = { ...PASSENGER_MESSAGE, replaceKey: null };

    expect('tag' in toExpoMessage(OWNER_TOKEN, withoutKey)).toBe(false);
    expect('collapseId' in toExpoMessage(OWNER_TOKEN, withoutKey)).toBe(false);
    expect(toExpoMessage(OWNER_TOKEN, PASSENGER_MESSAGE)).toMatchObject({
      tag: 'trip-17',
      collapseId: 'trip-17',
    });
  });
});

describe('ExpoPushTransport · outcomes and logs (T-8)', () => {
  let logs: CapturedLogs;

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it('a delivered passenger notice logs ids, type, counts and the lag, and returns sent', async () => {
    const { transport } = transportWith([OWNER_TOKEN, SECOND_OWNER_TOKEN]);

    const delivery = await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    expect(delivery).toEqual({ outcome: 'sent', tokens: 2, ok: 2, failed: 0 });
    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0]).toMatch(
      /^\[push:expo\] sent passenger=4529 tripRequest=17 type=trip_driver_assigned tokens=2 ok=2 failed=0 lagMs=\d+$/,
    );
  });

  it('a delivered driver notice keeps the log it had before the move', async () => {
    const { transport } = transportWith();

    await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

    expect(logs.lines).toEqual(['[push:expo] sent driver=7 assignment=42 tokens=1 ok=1 failed=0']);
  });

  it('a passenger without tokens logs no-token with the type and returns no_token', async () => {
    const { transport } = transportWith([]);

    const delivery = await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    expect(delivery).toEqual({ outcome: 'no_token' });
    expect(logs.lines).toEqual(['[push:expo] no-token passenger=4529 tripRequest=17 type=trip_driver_assigned']);
    expect(mockExpo.sent).toEqual([]);
  });

  it('a failed ticket is logged with a masked token and never with the full one', async () => {
    mockExpo.tickets = async () => [errorTicket('InvalidCredentials')];
    const { transport } = transportWith();

    await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    const joined = logs.lines.join('\n');
    expect(joined).toContain('reason=invalid_credentials passenger=4529');
    expect(joined).not.toContain(OWNER_TOKEN);
    expect(joined).not.toContain('ownerphoneAAAAAAAAAA');
    expect(joined).toContain(maskToken(OWNER_TOKEN));
  });

  it('an SDK that throws PUSH_TOO_MANY_EXPERIENCE_IDS with full tokens in details logs no token, no details and no error object', async () => {
    mockExpo.tickets = async () => {
      throw Object.assign(new Error('Too many experience ids'), {
        code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
        details: { '@owner/passenger': [OWNER_TOKEN], '@owner/driver': [SECOND_OWNER_TOKEN] },
      });
    };
    const { transport } = transportWith([OWNER_TOKEN, SECOND_OWNER_TOKEN]);

    const delivery = await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    expect(delivery).toEqual({ outcome: 'error' });
    const joined = logs.lines.join('\n');
    expect(joined).toBe('[push:expo] send failed passenger=4529 tripRequest=17 type=trip_driver_assigned');
    expect(joined).not.toContain('ownerphone');
    expect(joined).not.toContain('PUSH_TOO_MANY_EXPERIENCE_IDS');
    expect(joined).not.toContain('Too many experience ids');
  });

  it('the same SDK failure for the driver logs the line it logged before the move', async () => {
    mockExpo.tickets = async () => {
      throw Object.assign(new Error('boom'), { details: { token: OWNER_TOKEN } });
    };
    const { transport } = transportWith();

    await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

    expect(logs.lines).toEqual(['[push:expo] send failed driver=7 assignment=42']);
  });

  it('a delivery that never resolves is cut at PUSH_SEND_TIMEOUT_MS and logs a timeout without data', async () => {
    mockExpo.tickets = () => new Promise<ExpoPushTicket[]>(() => undefined);
    const { transport } = transportWith([OWNER_TOKEN], 30);

    const start = Date.now();
    const delivery = await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);
    const elapsed = Date.now() - start;

    expect(delivery).toEqual({ outcome: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(1000);
    expect(logs.lines).toEqual(['[push:expo] timeout passenger=4529 tripRequest=17 type=trip_driver_assigned ms=30']);
  });
});

describe('ExpoPushTransport · the nine guards that moved from assignment (ADR-034 section 1.1)', () => {
  let logs: CapturedLogs;

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it('guard 4: an SDK that throws never makes send reject', async () => {
    mockExpo.tickets = () => Promise.reject(new Error('exp.host is down'));
    const { transport } = transportWith();

    await expect(transport.send(7, DRIVER_MESSAGE, DRIVER_REF)).resolves.toEqual({ outcome: 'error' });
  });

  it('guard 4: a repository that throws never makes send reject', async () => {
    const { transport, listByUser } = transportWith();
    listByUser.mockRejectedValue(new Error('connection lost'));

    await expect(transport.send(7, DRIVER_MESSAGE, DRIVER_REF)).resolves.toEqual({ outcome: 'error' });
  });

  it('guard 4: a hanging SDK is bounded by PUSH_SEND_TIMEOUT_MS instead of blocking the caller', async () => {
    mockExpo.tickets = () => new Promise<ExpoPushTicket[]>(() => undefined);
    const { transport } = transportWith([OWNER_TOKEN], 30);

    const start = Date.now();
    await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('guard 5: a token with a bad format in the table never reaches Expo', async () => {
    const { transport } = transportWith(['not-an-expo-token', OWNER_TOKEN, 'FCM:raw-native-token']);

    await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

    expect(mockExpo.sent[0]?.map((m) => m.to)).toEqual([OWNER_TOKEN]);
  });

  it('guard 5: only malformed tokens -> Expo is not called and the outcome is no_token', async () => {
    const { transport } = transportWith(['not-an-expo-token']);

    const delivery = await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

    expect(delivery).toEqual({ outcome: 'no_token' });
    expect(mockExpo.sent).toEqual([]);
  });

  it.each(['DeviceNotRegistered', 'MismatchSenderId'] as const)(
    'guard 6: %s deletes the token row',
    async (code) => {
      mockExpo.tickets = async () => [errorTicket(code)];
      const { transport, drop } = transportWith();

      await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

      expect(drop).toHaveBeenCalledWith(OWNER_TOKEN);
    },
  );

  it.each(['InvalidCredentials', 'MessageTooBig', 'MessageRateExceeded'] as const)(
    'guard 6: %s never deletes a token (a configuration error must not empty the table)',
    async (code) => {
      mockExpo.tickets = async () => [errorTicket(code)];
      const { transport, drop } = transportWith();

      await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

      expect(drop).not.toHaveBeenCalled();
    },
  );

  it('guard 6: an unknown error code never deletes a token either', async () => {
    mockExpo.tickets = async () => [{ status: 'error', message: 'new code', details: undefined }];
    const { transport, drop } = transportWith();

    await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);

    expect(drop).not.toHaveBeenCalled();
  });

  it('guard 6: a failing delete of a dead token does not turn into an unhandled rejection or a failed send', async () => {
    mockExpo.tickets = async () => [errorTicket('DeviceNotRegistered')];
    const { transport, drop } = transportWith();
    drop.mockRejectedValue(new Error('db down'));

    await expect(transport.send(7, DRIVER_MESSAGE, DRIVER_REF)).resolves.toMatchObject({
      outcome: 'sent',
      failed: 1,
    });
  });

  it('guard 7: the token is masked in every failure log, for both audiences', async () => {
    mockExpo.tickets = async () => [errorTicket('DeviceNotRegistered')];
    const { transport } = transportWith();

    await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);
    await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    const joined = logs.lines.join('\n');
    expect(joined).not.toContain('ownerphoneAAAAAAAAAA');
    expect(joined).toContain('reason=device_not_registered driver=7');
    expect(joined).toContain('reason=device_not_registered passenger=4529');
  });

  it('guard 8: no log line contains the error of the SDK, its message, its code or its details', async () => {
    mockExpo.tickets = async () => {
      throw Object.assign(new Error('secret-sdk-message'), {
        code: 'SECRET_SDK_CODE',
        details: { leaked: [OWNER_TOKEN] },
      });
    };
    const { transport } = transportWith();

    await transport.send(7, DRIVER_MESSAGE, DRIVER_REF);
    await transport.send(4529, PASSENGER_MESSAGE, PASSENGER_REF);

    const joined = logs.lines.join('\n');
    for (const secret of ['secret-sdk-message', 'SECRET_SDK_CODE', 'leaked', 'ownerphone']) {
      expect(joined).not.toContain(secret);
    }
  });
});
