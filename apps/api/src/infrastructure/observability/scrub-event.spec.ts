import type { ErrorEvent } from '@sentry/node';
import { scrubEvent } from './scrub-event';

const ROW =
  'Failing row contains (41, Carrera 21 #14-33 Barrio La Esperanza, 6.96123417, -75.41759902, 482913)';

function buildEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    type: undefined,
    exception: {
      values: [
        {
          type: 'PrismaClientUnknownRequestError',
          value: `ERROR: x\nDETAIL: ${ROW}.`,
        },
      ],
    },
    ...overrides,
  };
}

describe('scrubEvent', () => {
  it('redacts the PostgreSQL detail in exception values and in the message', () => {
    const event = scrubEvent(buildEvent({ message: `DETAIL: ${ROW}` }));

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('Carrera 21');
    expect(serialized).not.toContain('6.96123417');
    expect(serialized).not.toContain('482913');
  });

  it('redacts sensitive keys in extra, contexts and breadcrumb data whatever their value', () => {
    const event = scrubEvent(
      buildEvent({
        extra: {
          pickup_address: 'Carrera 21 #14-33',
          lat: 6.96123417,
          lng: -75.41759902,
          start_code: '482913',
          startCode: '482913',
          driver_tracking: { lat: 6.9, lng: -75.4 },
          position: { latitude: 6.9 },
          nested: { current_lat: 6.9, current_lng: -75.4 },
          trip_request_id: 77,
        },
        contexts: { app: { first_name: 'Marcela', token: 'abc' } },
        breadcrumbs: [{ message: 'x', data: { dropoff_address: 'Calle 9', code: 'visible' } }],
      }),
    );

    expect(event?.extra).toEqual({
      pickup_address: '[redacted]',
      lat: '[redacted]',
      lng: '[redacted]',
      start_code: '[redacted]',
      startCode: '[redacted]',
      driver_tracking: '[redacted]',
      position: '[redacted]',
      nested: { current_lat: '[redacted]', current_lng: '[redacted]' },
      trip_request_id: 77,
    });
    expect(event?.contexts).toEqual({ app: { first_name: '[redacted]', token: '[redacted]' } });
    expect(event?.breadcrumbs?.[0]?.data).toEqual({ dropoff_address: '[redacted]', code: 'visible' });
  });

  it('matches sensitive keys case-insensitively', () => {
    const event = scrubEvent(buildEvent({ extra: { StartCode: '482913', LAT: 6.9 } }));

    expect(event?.extra).toEqual({ StartCode: '[redacted]', LAT: '[redacted]' });
  });

  it('drops events without diagnostic content', () => {
    expect(scrubEvent({ type: undefined })).toBeNull();
  });

  it('still strips the request body, cookies and non-allowed headers', () => {
    const event = scrubEvent(
      buildEvent({
        request: {
          url: 'https://api.voyya.test/trips/12?x=1',
          data: { pickup_address: 'Calle 1' },
          cookies: { a: 'b' },
          headers: { authorization: 'Bearer x', 'user-agent': 'jest' },
        },
      }),
    );

    expect(event?.request?.data).toBeUndefined();
    expect(event?.request?.cookies).toBeUndefined();
    expect(event?.request?.headers).toEqual({ 'user-agent': 'jest' });
  });
});
