import type { EnvService } from '../../../config/env.service';
import {
  expectedPassengerPushMessage,
  leakedTerms,
  SEEDED_TRIP_REQUEST_ID,
} from '../passenger/passenger-push.fixture';
import type { PushLogRef } from '../ports/push-transport.port';
import type { PushTokenRepository } from '../push-token.repository';

interface WireRequest {
  url: string;
  body: string;
  authorization: string | null;
}

const mockWire: { requests: WireRequest[] } = { requests: [] };

jest.mock(require.resolve('node-fetch', { paths: [require.resolve('expo-server-sdk')] }), () => {
  const actual = jest.requireActual(require.resolve('node-fetch', { paths: [require.resolve('expo-server-sdk')] }));
  const fetchStub = jest.fn(
    async (url: string, init: { body?: unknown; headers?: { get(name: string): string | null } }) => {
      mockWire.requests.push({
        url,
        body: String(init.body),
        authorization: init.headers?.get('authorization') ?? null,
      });
      return new actual.Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  return Object.assign(fetchStub, actual, { __esModule: true, default: fetchStub });
});

import { ExpoPushTransport } from './expo-push.transport';

const TOKEN = 'ExponentPushToken[ownerphoneAAAAAAAAAA]';
const REF: PushLogRef = {
  audience: 'passenger',
  tripRequestId: SEEDED_TRIP_REQUEST_ID,
  type: 'trip_driver_assigned',
  occurredAtMs: Date.now(),
};

function transport(accessToken = 'real-sdk-access-token'): ExpoPushTransport {
  const env = { get: () => 3000 } as unknown as EnvService;
  const tokens = {
    listByUser: jest.fn(async () => [TOKEN, 'not-an-expo-token']),
    drop: jest.fn(async () => undefined),
  } as unknown as PushTokenRepository;
  return new ExpoPushTransport(env, tokens, accessToken);
}

beforeEach(() => {
  mockWire.requests = [];
});

describe('ExpoPushTransport with the real expo-server-sdk (only the HTTP call is replaced)', () => {
  it('builds with the real SDK and sends one request to the Expo push endpoint', async () => {
    const delivery = await transport().send(4529, expectedPassengerPushMessage('trip_driver_assigned'), REF);

    expect(delivery).toEqual({ outcome: 'sent', tokens: 1, ok: 1, failed: 0 });
    expect(mockWire.requests).toHaveLength(1);
    expect(mockWire.requests[0]?.url).toBe('https://exp.host/--/api/v2/push/send');
  });

  it('puts exactly the ten fields of the contract on the wire, tag and collapseId included', async () => {
    await transport().send(4529, expectedPassengerPushMessage('trip_driver_assigned'), REF);

    const sent = JSON.parse(mockWire.requests[0]?.body ?? '[]') as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      to: TOKEN,
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
    expect(leakedTerms(mockWire.requests[0]?.body ?? '')).toEqual([]);
  });

  it('sends the access token as a bearer credential, so the enhanced push security of EAS can accept the call', async () => {
    await transport('real-sdk-access-token').send(4529, expectedPassengerPushMessage('trip_no_driver'), REF);

    expect(mockWire.requests[0]?.authorization).toBe('Bearer real-sdk-access-token');
  });

  it('never sends a token whose format Expo would reject', async () => {
    await transport().send(4529, expectedPassengerPushMessage('trip_driver_arrived'), REF);

    expect(mockWire.requests[0]?.body).not.toContain('not-an-expo-token');
  });
});
