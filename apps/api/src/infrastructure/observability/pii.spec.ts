import { redactPii, redactPiiDeep } from '@voyyaa/shared';

describe('redactPii', () => {
  it('redacts a Colombian phone in E.164 format with separators', () => {
    expect(redactPii('llamar al +57 300 111 2233 urgente')).toBe('llamar al [phone] urgente');
  });

  it('redacts a Colombian phone in local format', () => {
    expect(redactPii('tel 300 111 2233')).toBe('tel [phone]');
  });

  it('redacts an email address', () => {
    expect(redactPii('contacto: pasajero@voyya.test')).toBe('contacto: [email]');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123XYZ-_';
    expect(redactPii(`token=${jwt}`)).toBe('token=[jwt]');
  });

  it('redacts a Bearer header value', () => {
    expect(redactPii('Authorization: Bearer abc123.def456')).toBe(
      'Authorization: Bearer [redacted]',
    );
  });

  it('redacts an Expo push token', () => {
    expect(redactPii('push to ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(
      'push to [push-token]',
    );
  });

  it('redacts a labelled national id while keeping the label', () => {
    expect(redactPii('cédula 1234567890')).toBe('cédula [redacted]');
  });

  it('redacts a labelled pin while keeping the label', () => {
    expect(redactPii('PIN: 4821')).toBe('PIN: [redacted]');
  });

  it('does not touch unlabelled numeric identifiers used in operational logs', () => {
    expect(redactPii('assignment=412')).toBe('assignment=412');
    expect(redactPii('fare=8000')).toBe('fare=8000');
    expect(redactPii('occurred_at=2026-09-25T14:03:11.002Z')).toBe(
      'occurred_at=2026-09-25T14:03:11.002Z',
    );
    expect(redactPii('epoch=1758808991002')).toBe('epoch=1758808991002');
  });
});

describe('redactPiiDeep', () => {
  it('redacts string values inside a nested object', () => {
    const input = { user: { phone: '+57 300 111 2233', id: 37 }, note: 'cédula 1234567890' };
    expect(redactPiiDeep(input)).toEqual({
      user: { phone: '[phone]', id: 37 },
      note: 'cédula [redacted]',
    });
  });

  it('redacts string values inside arrays', () => {
    expect(redactPiiDeep(['tel 300 111 2233', 'assignment=412'])).toEqual([
      'tel [phone]',
      'assignment=412',
    ]);
  });

  it('caps recursion depth to avoid cyclic-structure hangs', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 10; i += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(() => redactPiiDeep(deep)).not.toThrow();
  });
});

describe('redactPii 0.8.1 case table', () => {
  it.each([
    ['national_id=71000001', 'national_id=[redacted]'],
    ['{"national_id":"71000001"}', '{"national_id":"[redacted]"}'],
    ['nationalId: 71000001', 'nationalId: [redacted]'],
    ['current_pin=482913&new_pin=591027', 'current_pin=[redacted]&new_pin=[redacted]'],
    ['{"current_pin":"482913","new_pin":"591027"}', '{"current_pin":"[redacted]","new_pin":"[redacted]"}'],
    ['new_pin 482913', 'new_pin [redacted]'],
    ['CC 71000001', 'CC [redacted]'],
    ['C.C. 71.000.001', 'C.C. [redacted]'],
    ['cédula 71 000 001', 'cédula [redacted]'],
    ['pin: 48 29 13', 'pin: [redacted]'],
    ['Cédula: 71 000 001 registrada', 'Cédula: [redacted] registrada'],
    ['pin=482913 2026-10-08', 'pin=[redacted] 2026-10-08'],
    [
      'VoyYa · PIN 482913. Ingresa con tu número de cédula y este PIN.',
      'VoyYa · PIN [redacted] Ingresa con tu número de cédula y este PIN.',
    ],
  ])('redacts %s', (input, expected) => {
    expect(redactPii(input)).toBe(expected);
  });

  it.each([
    '{route: /pin POST}',
    'POST /auth/driver/pin} 403',
    '/admin/drivers/5/pin/resend',
    '{"field":"new_pin","error":"El PIN debe tener 6 dígitos"}',
    'pin_delivered_at=2026-10-08',
    'pin_must_change=true',
    'access 2026',
    'pin 12',
    'pin 12 veces',
    'licencia vencida 2026',
    'PIN [redacted]',
    'assignment=412 fare=8000',
    'driver.national_id=71000001',
  ])('leaves %s untouched', (input) => {
    expect(redactPii(input)).toBe(input);
  });

  it('is idempotent', () => {
    const once = redactPii('current_pin=482913&new_pin=591027 cédula 71 000 001');
    expect(redactPii(once)).toBe(once);
  });
});

describe('redactPii PostgreSQL error detail', () => {
  const ROW =
    'Failing row contains (41, 7, Calle 50 #12-34 (Barrio El Centro), 6.9612, -75.4175, 482913, taxi)';

  it('redacts the failing row of a check violation and keeps the rest of the message', () => {
    const message = `Raw query failed. Code: \`23514\`. Message: \`ERROR: new row for relation "trip_request" violates check constraint "trip_request_no_motorcycle"\nDETAIL: ${ROW}.\``;
    const out = redactPii(message);
    expect(out).toContain('violates check constraint "trip_request_no_motorcycle"');
    expect(out).toContain('DETAIL: [redacted]');
    expect(out).not.toContain('Calle 50');
    expect(out).not.toContain('6.9612');
    expect(out).not.toContain('482913');
  });

  it('redacts a failing row that is not inside a DETAIL line', () => {
    expect(redactPii(`x ${ROW}.`)).toBe('x Failing row contains ([redacted])');
  });

  it('redacts the duplicated value of a unique violation', () => {
    expect(redactPii('Key (start_code)=(482913) already exists.')).toBe(
      'Key ([redacted])=([redacted]) already exists.',
    );
  });

  it('redacts a key value that contains parentheses', () => {
    expect(redactPii('Key (address)=(Calle 5 (esq) 10) already exists.')).toBe(
      'Key ([redacted])=([redacted]) already exists.',
    );
  });

  it('redacts the referenced key of a foreign key violation', () => {
    expect(
      redactPii('Key (driver_id)=(99) is not present in table "driver".'),
    ).toBe('Key ([redacted])=([redacted]) is not present in table "driver".');
  });

  it('removes a DETAIL line without eating the stack that follows', () => {
    const out = redactPii('ERROR: boom\nDETAIL: Failing row contains (1, secret)\n    at foo (bar.ts:1:1)');
    expect(out).toBe('ERROR: boom\nDETAIL: [redacted]\n    at foo (bar.ts:1:1)');
  });

  it('stops at an escaped newline inside a JSON-encoded message', () => {
    const out = redactPii('{"m":"ERROR: x\nDETAIL: Failing row contains (1, secret)\n    at foo"}');
    expect(out).not.toContain('secret');
    expect(out).toContain('\n    at foo"}');
  });

  it('is idempotent on PostgreSQL detail', () => {
    const once = redactPii(`ERROR: x\nDETAIL: ${ROW}.\nKey (a)=(b) already exists.`);
    expect(redactPii(once)).toBe(once);
  });
});

describe('redactPiiDeep PostgreSQL error detail and error objects', () => {
  const ROW = 'Failing row contains (41, Calle 50 #12-34, 6.9612, -75.4175, 482913)';

  it('redacts the detail inside an Error: message, stack and own properties', () => {
    const error = Object.assign(new Error(`ERROR: x\nDETAIL: ${ROW}.`), {
      code: 'P2010',
      meta: { code: '23514', message: `ERROR: x\nDETAIL: ${ROW}.` },
    });
    const out = JSON.stringify(redactPiiDeep({ err: error }));
    expect(out).not.toContain('Calle 50');
    expect(out).not.toContain('6.9612');
    expect(out).not.toContain('482913');
    expect(out).toContain('"code":"P2010"');
    expect(out).toContain('"code":"23514"');
  });

  it('redacts the detail nested in objects and arrays', () => {
    const out = JSON.stringify(redactPiiDeep({ a: [{ b: `DETAIL: ${ROW}` }] }));
    expect(out).not.toContain('Calle 50');
  });

  it('keeps dates and other non-plain values intact', () => {
    const date = new Date('2026-10-09T00:00:00.000Z');
    expect(redactPiiDeep({ at: date, n: 3, flag: true })).toEqual({ at: date, n: 3, flag: true });
  });
});
