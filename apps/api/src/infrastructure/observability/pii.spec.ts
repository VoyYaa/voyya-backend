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
