import { driverCredentialsSms } from './messages';

describe('driverCredentialsSms', () => {
  it('states the validity in hours derived from the TTL', () => {
    expect(driverCredentialsSms('482913', 72)).toContain('Vence en 72 horas.');
  });

  it('uses the singular for a one hour TTL', () => {
    expect(driverCredentialsSms('482913', 1)).toContain('Vence en 1 hora.');
  });

  it('carries the PIN and no national id number', () => {
    const message = driverCredentialsSms('482913', 72);
    expect(message).toContain('PIN 482913');
    expect(message).not.toMatch(/c.dula\s*\d/i);
  });
});
